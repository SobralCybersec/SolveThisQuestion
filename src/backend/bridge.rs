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

use super::state::{AppState, ChatRequest, ProxyConfig};

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

pub(crate) struct BridgeRunRequest {
    pub(crate) run_id: Uuid,
    pub(crate) url: String,
    pub(crate) prompt: String,
    pub(crate) web_search: bool,
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
    request: &BridgeRunRequest,
) -> Result<serde_json::Value> {
    ensure_embedded_login(state).await?;
    agent_request(
        state,
        serde_json::json!({
            "cmd": "analyze",
            "run_id": request.run_id,
            "url": request.url,
            "prompt": request.prompt,
            "web_search": request.web_search,
        }),
        250,
    )
    .await
}

pub(crate) async fn chat_bridge(
    state: &AppState,
    request: &ChatRequest,
) -> Result<serde_json::Value> {
    ensure_embedded_login(state).await?;
    agent_request(
        state,
        serde_json::json!({
            "cmd": "chat",
            "prompt": request.prompt,
            "history": request.history,
            "web_search": request.web_search,
        }),
        250,
    )
    .await
}

async fn ensure_embedded_login(state: &AppState) -> Result<()> {
    if !state.proxy.read().await.url.is_empty() {
        return Ok(());
    }
    let status = agent_request(state, serde_json::json!({ "cmd": "status" }), 30).await?;
    if status.get("logged_in") != Some(&serde_json::Value::Bool(true)) {
        anyhow::bail!("ChatGPT login required. Open embedded ChatGPT login first.");
    }
    Ok(())
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

fn bridge_bool(value: bool) -> &'static str {
    if value {
        "true"
    } else {
        "false"
    }
}

fn set_optional_env(command: &mut Command, name: &str, value: Option<&str>) {
    if let Some(value) = value {
        command.env(name, value);
    }
}

fn configure_bridge_command(command: &mut Command, state: &AppState, config: &ProxyConfig) {
    command
        .arg(&state.bridge)
        .current_dir(state.bridge.parent().unwrap_or(Path::new(".")))
        .env("SCREEN_AGENT_RUNTIME", &state.runtime)
        .env("GPT_PROXY_MODEL", &config.model)
        .env("GPT_PROXY_CHATGPT_MODE", &config.chatgpt_mode)
        .env(
            "SCREEN_AGENT_CHATGPT_THINK",
            bridge_bool(config.chatgpt_think),
        )
        .env(
            "SCREEN_AGENT_IMGLINK_UPLOAD",
            bridge_bool(config.imglink_upload),
        )
        .env(
            "SCREEN_AGENT_IMAGE_UPLOAD_PROVIDERS",
            &config.image_upload_providers,
        );
    if !config.url.is_empty() {
        command.env("GPT_PROXY_URL", &config.url);
    }
    set_optional_env(command, "GPT_PROXY_API_KEY", config.api_key.as_deref());
    set_optional_env(
        command,
        "GPT_PROXY_SESSION_ID",
        config.session_id.as_deref(),
    );
    set_optional_env(
        command,
        "SCREEN_AGENT_IMGLINK_API_KEY",
        config.imglink_api_key.as_deref(),
    );
    set_optional_env(
        command,
        "SCREEN_AGENT_IMGPILE_API_TOKEN",
        config.imgpile_api_token.as_deref(),
    );
    set_optional_env(
        command,
        "SCREEN_AGENT_POSTIMAGES_API_TOKEN",
        config.postimages_api_token.as_deref(),
    );
    set_optional_env(
        command,
        "SCREEN_AGENT_IMGBB_API_KEY",
        config.imgbb_api_key.as_deref(),
    );
}

pub(crate) fn bridge_command(state: &AppState, config: &ProxyConfig) -> Command {
    let mut command = Command::new(node_binary());
    configure_bridge_command(&mut command, state, config);
    command
}

fn node_binary() -> &'static str {
    if cfg!(windows) {
        "node.exe"
    } else {
        "node"
    }
}
