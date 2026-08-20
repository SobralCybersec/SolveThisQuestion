use anyhow::{Context, Result};
use std::{
    io::ErrorKind,
    path::{Path, PathBuf},
    process::Command as StdCommand,
};
use tokio::{
    fs::OpenOptions,
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
    time::{sleep, Duration},
};
use uuid::Uuid;

use crate::state::{AppState, ProxyConfig};

pub(crate) struct BridgeProcess {
    pub(crate) child: Child,
    pub(crate) stdin: ChildStdin,
    pub(crate) stdout: BufReader<ChildStdout>,
    pub(crate) _process_lock: BridgeProcessLock,
}

impl BridgeProcess {
    pub(crate) async fn request(
        &mut self,
        command: serde_json::Value,
    ) -> Result<serde_json::Value> {
        self.stdin
            .write_all(format!("{command}\n").as_bytes())
            .await?;
        self.stdin.flush().await?;
        let mut line = String::new();
        self.stdout.read_line(&mut line).await?;
        let value: serde_json::Value =
            serde_json::from_str(line.trim()).context("parse persistent bridge response")?;
        if let Some(error) = value.get("error") {
            anyhow::bail!("{error}");
        }
        Ok(value.get("result").cloned().unwrap_or(value))
    }

    pub(crate) async fn shutdown(mut self) {
        drop(self.stdin);
        if tokio::time::timeout(Duration::from_secs(6), self.child.wait())
            .await
            .is_err()
        {
            let _ = self.child.kill().await;
            let _ = self.child.wait().await;
        }
    }
}

pub(crate) struct BridgeProcessLock {
    path: PathBuf,
    _file: tokio::fs::File,
}

impl Drop for BridgeProcessLock {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

fn process_is_alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        StdCommand::new("kill")
            .args(["-0", &pid.to_string()])
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        true
    }
}

pub(crate) async fn acquire_bridge_process_lock(runtime: &Path) -> Result<BridgeProcessLock> {
    let path = runtime.join("bridge-process.lock");
    for _ in 0..1200 {
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .await
        {
            Ok(mut file) => {
                file.write_all(std::process::id().to_string().as_bytes())
                    .await
                    .context("write bridge process lock")?;
                return Ok(BridgeProcessLock { path, _file: file });
            }
            Err(error) if error.kind() == ErrorKind::AlreadyExists => {
                let owner = tokio::fs::read_to_string(&path)
                    .await
                    .ok()
                    .and_then(|value| value.trim().parse::<u32>().ok());
                if owner.is_some_and(|pid| !process_is_alive(pid)) {
                    let _ = tokio::fs::remove_file(&path).await;
                    continue;
                }
                sleep(Duration::from_millis(250)).await;
            }
            Err(error) => {
                return Err(error)
                    .with_context(|| format!("create bridge process lock {}", path.display()))
            }
        }
    }
    anyhow::bail!("another Screen Agent bridge is using ChatGPT profile; retry after it exits")
}

pub(crate) async fn run_bridge(
    state: &AppState,
    run_id: Uuid,
    url: String,
    prompt: String,
    web_search: bool,
) -> Result<serde_json::Value> {
    if state.proxy.read().await.url.is_empty() {
        let status = agent_request(state, serde_json::json!({ "cmd": "status" }), 30).await?;
        if status.get("logged_in") != Some(&serde_json::Value::Bool(true)) {
            anyhow::bail!("ChatGPT login required. Open embedded ChatGPT login first.");
        }
    }
    agent_request(
        state,
        serde_json::json!({
            "cmd": "analyze",
            "run_id": run_id,
            "url": url,
            "prompt": prompt,
            "web_search": web_search,
        }),
        250,
    )
    .await
}

pub(crate) async fn spawn_bridge_process(state: &AppState) -> Result<BridgeProcess> {
    let lock = acquire_bridge_process_lock(&state.runtime).await?;
    let config = state.proxy.read().await.clone();
    let mut child = bridge_command(state, &config)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .context("start Playwright bridge; install Node.js and bridge dependencies")?;
    let stdin = child.stdin.take().context("open bridge stdin")?;
    let stdout = child.stdout.take().context("open bridge stdout")?;
    Ok(BridgeProcess {
        child,
        stdin,
        stdout: BufReader::new(stdout),
        _process_lock: lock,
    })
}

pub(crate) async fn close_agent_bridge(state: &AppState) {
    if let Some(bridge) = state.agent_bridge.lock().await.take() {
        bridge.shutdown().await;
    }
}

pub(crate) async fn close_login_bridge(state: &AppState) -> Result<()> {
    let mut login_bridge = state.login_bridge.lock().await;
    let Some(mut bridge) = login_bridge.take() else {
        state
            .login_in_progress
            .store(false, std::sync::atomic::Ordering::Release);
        return Ok(());
    };
    let result = match tokio::time::timeout(
        Duration::from_secs(8),
        bridge.request(serde_json::json!({ "cmd": "close_login" })),
    )
    .await
    {
        Ok(Ok(_)) => Ok(()),
        Ok(Err(error)) => Err(error),
        Err(_) => Err(anyhow::anyhow!("closing ChatGPT login timed out")),
    };
    let _ = bridge.child.kill().await;
    let _ = bridge.child.wait().await;
    state
        .login_in_progress
        .store(false, std::sync::atomic::Ordering::Release);
    result
}

pub(crate) async fn agent_request(
    state: &AppState,
    command: serde_json::Value,
    timeout_secs: u64,
) -> Result<serde_json::Value> {
    let _bridge_guard = state.bridge_busy.lock().await;
    if state
        .login_in_progress
        .load(std::sync::atomic::Ordering::Acquire)
    {
        close_login_bridge(state).await?;
    }
    let mut slot = state.agent_bridge.lock().await;
    let mut last_error = None;
    for attempt in 0..2 {
        if slot.is_none() {
            *slot = Some(spawn_bridge_process(state).await?);
        }
        let bridge = slot.as_mut().expect("agent bridge present");
        match tokio::time::timeout(
            Duration::from_secs(timeout_secs),
            bridge.request(command.clone()),
        )
        .await
        {
            Ok(Ok(value)) => return Ok(value),
            Ok(Err(error)) => last_error = Some(error),
            Err(_) => last_error = Some(anyhow::anyhow!("bridge request timed out")),
        }
        if let Some(bridge) = slot.take() {
            bridge.shutdown().await;
        }
        if attempt == 1 {
            break;
        }
    }
    Err(last_error.unwrap_or_else(|| anyhow::anyhow!("bridge request failed")))
}

pub(crate) fn bridge_command(state: &AppState, config: &ProxyConfig) -> Command {
    let mut child_command = Command::new(node_binary());
    child_command
        .arg(&state.bridge)
        .current_dir(state.bridge.parent().unwrap_or(Path::new(".")))
        .env("SCREEN_AGENT_RUNTIME", &state.runtime)
        .env("GPT_PROXY_MODEL", &config.model)
        .env("GPT_PROXY_CHATGPT_MODE", &config.chatgpt_mode)
        .env(
            "SCREEN_AGENT_CHATGPT_THINK",
            if config.chatgpt_think {
                "true"
            } else {
                "false"
            },
        )
        .env(
            "SCREEN_AGENT_IMGLINK_UPLOAD",
            if config.imglink_upload {
                "true"
            } else {
                "false"
            },
        );
    if !config.url.is_empty() {
        child_command.env("GPT_PROXY_URL", &config.url);
    }
    if let Some(key) = &config.api_key {
        child_command.env("GPT_PROXY_API_KEY", key);
    }
    if let Some(session_id) = &config.session_id {
        child_command.env("GPT_PROXY_SESSION_ID", session_id);
    }
    if let Some(key) = &config.imglink_api_key {
        child_command.env("SCREEN_AGENT_IMGLINK_API_KEY", key);
    }
    child_command
}

fn node_binary() -> &'static str {
    if cfg!(windows) {
        "node.exe"
    } else {
        "node"
    }
}
