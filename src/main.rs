use anyhow::{Context, Result};
use axum::{
    extract::State,
    http::{header, Method, StatusCode},
    response::sse::{Event, KeepAlive, Sse},
    routing::{get, post},
    Json, Router,
};
use futures_util::{stream::Stream, StreamExt};
use notify_rust::Notification;
use serde::{Deserialize, Serialize};
use std::{
    convert::Infallible,
    env,
    io::ErrorKind,
    net::SocketAddr,
    path::{Path, PathBuf},
    process::Command as StdCommand,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
use tauri::Manager;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tokio::{
    fs::OpenOptions,
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
    sync::{broadcast, Mutex, RwLock},
    time::{sleep, Duration},
};
use tokio_stream::wrappers::BroadcastStream;
use tower_http::{cors::CorsLayer, services::ServeDir};
use uuid::Uuid;
use xcap::Monitor;

#[derive(Clone)]
struct AppState {
    app: tauri::AppHandle,
    events: broadcast::Sender<AgentEvent>,
    bridge: PathBuf,
    runtime: PathBuf,
    proxy: Arc<RwLock<ProxyConfig>>,
    bridge_busy: Arc<Mutex<()>>,
    login_in_progress: Arc<AtomicBool>,
    login_bridge: Arc<Mutex<Option<BridgeProcess>>>,
    // Long-lived capture bridge kept warm between captures so the ChatGPT
    // browser is not relaunched on every screenshot. Holds the profile lock
    // while alive, so login and config changes tear it down first.
    agent_bridge: Arc<Mutex<Option<BridgeProcess>>>,
    capture_busy: Arc<AtomicBool>,
}

struct BridgeProcess {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    _process_lock: BridgeProcessLock,
}

impl BridgeProcess {
    async fn request(&mut self, command: serde_json::Value) -> Result<serde_json::Value> {
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

    // Close stdin so the bridge's readline loop ends and it tears down its warm
    // browser (and the embedded proxy grandchild) gracefully; kill if it lingers.
    async fn shutdown(mut self) {
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

#[derive(Clone, Debug, Serialize)]
struct AgentEvent {
    event: String,
    data: serde_json::Value,
}

#[derive(Debug, Deserialize)]
struct RunRequest {
    prompt: String,
    #[serde(default)]
    web_search: bool,
    #[serde(default = "default_url")]
    url: String,
}

#[derive(Serialize)]
struct RunResponse {
    run_id: Uuid,
    status: &'static str,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct ProxyConfig {
    url: String,
    api_key: Option<String>,
    model: String,
    chatgpt_mode: String,
    #[serde(default)]
    chatgpt_think: bool,
    session_id: Option<String>,
    hotkey: String,
    imglink_upload: bool,
    imglink_api_key: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ConfigUpdate {
    url: Option<String>,
    api_key: Option<String>,
    clear_api_key: Option<bool>,
    model: Option<String>,
    chatgpt_mode: Option<String>,
    chatgpt_think: Option<bool>,
    session_id: Option<String>,
    hotkey: Option<String>,
    imglink_upload: Option<bool>,
    imglink_api_key: Option<String>,
    clear_imglink_api_key: Option<bool>,
}

fn default_url() -> String {
    "https://example.com".to_owned()
}

fn prompt_with_short_answer(prompt: String) -> String {
    if prompt.to_ascii_lowercase().contains("short answer:") {
        prompt
    } else {
        format!(
            "{prompt}\n\nEnd with exactly one final line: Short Answer: actual concise answer. Do not repeat the label or use quotation marks."
        )
    }
}

fn default_screen_prompt() -> String {
    "Read the uploaded desktop screenshot and find every question, problem, or exercise in it. Solve each one and actually work it out: read the given values, do the calculations or reasoning step by step, and reach a correct result — never guess or leave a question unanswered. Preserve the visible numbering (Q.1, Q.2, and Q.1.a) for subparts). Use only text that is actually readable in the image; do not invent missing text, and if part of a problem is unreadable, say so for that item. Do not describe the browser, the page layout, or the screenshot itself — spend the output on solving. If no question is present, give one concise, useful answer about the visible content. After your working, end with exactly one final line: Short Answer: the concise result for each item (for example Q.1) 42, Q.2) yes). Do not repeat the label or wrap the answer in quotation marks.".to_owned()
}

fn short_answer(answer: &str) -> String {
    let value = answer
        .rsplit_once("Short Answer:")
        .map(|(_, value)| value.trim())
        .filter(|value| !value.is_empty())
        // No "Short Answer:" marker: return the whole answer, not just its first
        // line — cropping to one line dropped the rest in the notification.
        .unwrap_or_else(|| answer.trim());
    value
        .trim()
        .trim_matches(|character| matches!(character, '"' | '\'' | '`'))
        .trim()
        .to_owned()
}

fn wayland_hyprland() -> bool {
    cfg!(target_os = "linux")
        && env::var_os("WAYLAND_DISPLAY").is_some()
        && env::var_os("HYPRLAND_INSTANCE_SIGNATURE").is_some()
}

fn hyprland_hotkey(hotkey: &str) -> Result<String> {
    let mut parts = hotkey
        .split('+')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();
    let key = parts.pop().context("hotkey must include a key")?.to_owned();
    let mut modifiers = Vec::new();
    for modifier in parts {
        modifiers.push(match modifier.to_ascii_lowercase().as_str() {
            "commandorcontrol" | "command" | "super" | "meta" | "win" => "SUPER",
            "control" | "ctrl" => "CTRL",
            "alt" | "option" => "ALT",
            "shift" => "SHIFT",
            other => return Err(anyhow::anyhow!("unsupported Hyprland modifier: {other}")),
        });
    }
    let key = match key.as_str() {
        "PrintScreen" | "Printscreen" => "Print",
        "Space" => "Space",
        "Enter" => "Return",
        "Escape" => "Escape",
        value if value.starts_with("Key") && value.len() == 4 => &value[3..],
        value if value.starts_with("Digit") && value.len() == 6 => &value[5..],
        value => value,
    };
    if !key
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | ':'))
    {
        return Err(anyhow::anyhow!("unsupported Hyprland key: {key}"));
    }
    let key = if key.len() == 1 {
        key.to_ascii_uppercase()
    } else {
        key.to_owned()
    };
    Ok(if modifiers.is_empty() {
        key
    } else {
        format!("{} + {key}", modifiers.join(" + "))
    })
}

fn hyprland_shortcut_command(port: u16) -> String {
    format!(
        "curl --silent --show-error --fail --max-time 2 --request POST http://127.0.0.1:{port}/api/capture >/dev/null 2>&1"
    )
}

fn register_hotkey(app: &tauri::AppHandle, hotkey: &str, port: u16) -> Result<()> {
    if hotkey.is_empty() {
        return Ok(());
    }
    if wayland_hyprland() {
        tracing::info!(%hotkey, %port, "registering Hyprland screenshot keybind");
        let keys = hyprland_hotkey(hotkey)?;
        let command = hyprland_shortcut_command(port)
            .replace('\\', "\\\\")
            .replace('"', "\\\"");
        let bind = format!("hl.bind(\"{keys}\", hl.dsp.exec_cmd(\"{command}\"))");
        let result = StdCommand::new("hyprctl")
            .args(["eval", &bind])
            .output()
            .context("run hyprctl eval bind")?;
        if !result.status.success() {
            return Err(anyhow::anyhow!(
                "Hyprland rejected screenshot keybind: {}",
                String::from_utf8_lossy(&result.stderr).trim()
            ));
        }
        return Ok(());
    }
    tracing::info!(%hotkey, "registering Tauri screenshot keybind");
    app.global_shortcut().register(hotkey)?;
    Ok(())
}

fn unregister_hotkey(app: &tauri::AppHandle, hotkey: &str) -> Result<()> {
    if hotkey.is_empty() {
        return Ok(());
    }
    if wayland_hyprland() {
        let bind = format!("hl.unbind(\"{}\")", hyprland_hotkey(hotkey)?);
        let result = StdCommand::new("hyprctl")
            .args(["eval", &bind])
            .output()
            .context("run hyprctl eval unbind")?;
        if !result.status.success() {
            return Err(anyhow::anyhow!(
                "Hyprland rejected screenshot keybind removal: {}",
                String::from_utf8_lossy(&result.stderr).trim()
            ));
        }
        return Ok(());
    }
    app.global_shortcut().unregister(hotkey)?;
    Ok(())
}

#[cfg(target_os = "linux")]
fn configure_linux_display() {
    if env::var_os("WEBKIT_DISABLE_COMPOSITING_MODE").is_none() {
        unsafe { env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1") };
    }
    let explicit_x11 = env::var_os("GDK_BACKEND")
        .map(|value| value.to_string_lossy().to_ascii_lowercase().contains("x11"))
        .unwrap_or(false);
    let wayland_session = env::var_os("WAYLAND_DISPLAY").is_some()
        || env::var("XDG_SESSION_TYPE")
            .map(|value| value.eq_ignore_ascii_case("wayland"))
            .unwrap_or(false);
    if wayland_session && !explicit_x11 && env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        unsafe { env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1") };
    }
}

#[cfg(not(target_os = "linux"))]
fn configure_linux_display() {}

#[cfg(target_os = "linux")]
fn suppress_ayatana_deprecation_warning() {
    glib::log_set_handler(
        Some("libayatana-appindicator"),
        glib::LogLevels::LEVEL_WARNING,
        false,
        false,
        |_domain, _level, _message| {},
    );
}

#[cfg(not(target_os = "linux"))]
fn suppress_ayatana_deprecation_warning() {}

fn main() {
    configure_linux_display();
    suppress_ayatana_deprecation_warning();
    tracing_subscriber::fmt::init();

    tauri::Builder::default()
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        trigger_desktop_capture(app.clone());
                    }
                })
                .build(),
        )
        .setup(|app| {
            create_tray(app)?;
            let source_bridge = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("bridge/index.mjs");
            let bridge = app
                .path()
                .resource_dir()
                .ok()
                .map(|path| path.join("bridge/index.mjs"))
                .filter(|path| {
                    path.exists()
                        && path
                            .parent()
                            .map(|parent| parent.join("node_modules/playwright").exists())
                            .unwrap_or(false)
                })
                .or_else(|| source_bridge.exists().then_some(source_bridge.clone()))
                .ok_or_else(|| anyhow::anyhow!("Playwright bridge not found with dependencies"))?;
            let runtime = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(".runtime"))
                .join("runtime");
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(error) = run_server(app_handle, bridge, runtime).await {
                    tracing::error!(%error, "screen-agent server stopped");
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Screen Agent");
}

async fn run_server(app: tauri::AppHandle, bridge: PathBuf, runtime: PathBuf) -> Result<()> {
    let port = env::var("SCREEN_AGENT_PORT")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(8787);
    tokio::fs::create_dir_all(runtime.join("captures")).await?;
    let (event_tx, _) = broadcast::channel(64);

    let config_path = runtime.join("config.json");
    let config = load_saved_config(&config_path)
        .await
        .unwrap_or_else(proxy_config_from_env);
    let state = Arc::new(AppState {
        app: app.clone(),
        events: event_tx,
        bridge,
        runtime: runtime.clone(),
        proxy: Arc::new(RwLock::new(config.clone())),
        bridge_busy: Arc::new(Mutex::new(())),
        login_in_progress: Arc::new(AtomicBool::new(false)),
        login_bridge: Arc::new(Mutex::new(None)),
        agent_bridge: Arc::new(Mutex::new(None)),
        capture_busy: Arc::new(AtomicBool::new(false)),
    });
    app.manage(Arc::clone(&state));
    register_hotkey(&app, &config.hotkey, port)?;

    let cors = CorsLayer::new()
        .allow_origin(tower_http::cors::Any)
        .allow_methods([Method::GET, Method::POST, Method::PUT])
        .allow_headers([header::CONTENT_TYPE]);
    let app = Router::new()
        .route("/api/health", get(health))
        .route("/api/config", get(get_config).put(update_config))
        .route("/api/proxy/login", post(proxy_login))
        .route("/api/proxy/close-login", post(proxy_close_login))
        .route("/api/proxy/status", get(proxy_status))
        .route("/api/events", get(events))
        .route("/api/capture", post(capture))
        .route("/api/run", post(run))
        .nest_service("/captures", ServeDir::new(runtime.join("captures")))
        .layer(cors)
        .with_state(state);

    let address = SocketAddr::from(([127, 0, 0, 1], port));
    tracing::info!(%address, "screen-agent listening");
    let listener = tokio::net::TcpListener::bind(address).await?;
    axum::serve(listener, app).await?;
    Ok(())
}

fn proxy_config_from_env() -> ProxyConfig {
    let hub_url = env_value(&["RUST_PROXY_HUB_URL"]);
    let model = env_value(&["RUST_PROXY_HUB_MODEL", "GPT_PROXY_MODEL"])
        .unwrap_or_else(|| "chatgpt:chatgpt-web-session".to_owned());
    ProxyConfig {
        url: hub_url
            .or_else(|| env_value(&["GPT_PROXY_URL"]))
            .unwrap_or_default(),
        api_key: env_value(&["RUST_PROXY_HUB_API_KEY", "GPT_PROXY_API_KEY"]),
        model,
        chatgpt_mode: env_value(&["RUST_PROXY_HUB_CHATGPT_MODE", "GPT_PROXY_CHATGPT_MODE"])
            .unwrap_or_else(|| "web".to_owned()),
        chatgpt_think: env_bool("SCREEN_AGENT_CHATGPT_THINK", false),
        session_id: env_value(&["RUST_PROXY_HUB_SESSION_ID", "GPT_PROXY_SESSION_ID"]),
        hotkey: env_value(&["SCREEN_AGENT_HOTKEY"])
            .unwrap_or_else(|| "CommandOrControl+Shift+S".to_owned()),
        imglink_upload: env_value(&["SCREEN_AGENT_IMGLINK_UPLOAD"])
            .map(|value| matches!(value.as_str(), "1" | "true" | "yes" | "on"))
            .unwrap_or(false),
        imglink_api_key: env_value(&["SCREEN_AGENT_IMGLINK_API_KEY", "IMGLINK_API_KEY"]),
    }
}

async fn load_saved_config(path: &Path) -> Option<ProxyConfig> {
    let bytes = tokio::fs::read(path).await.ok()?;
    match serde_json::from_slice(&bytes) {
        Ok(config) => Some(config),
        Err(error) => {
            tracing::warn!(path = %path.display(), %error, "ignoring invalid saved config");
            None
        }
    }
}

async fn save_config(path: &Path, config: &ProxyConfig) -> Result<()> {
    let bytes = serde_json::to_vec_pretty(config).context("serialize proxy config")?;
    tokio::fs::write(path, bytes)
        .await
        .with_context(|| format!("write proxy config {}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = tokio::fs::metadata(path).await?.permissions();
        permissions.set_mode(0o600);
        tokio::fs::set_permissions(path, permissions).await?;
    }
    Ok(())
}

fn process_is_alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        return StdCommand::new("kill")
            .args(["-0", &pid.to_string()])
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok_and(|status| status.success());
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        true
    }
}

struct BridgeProcessLock {
    path: PathBuf,
    _file: tokio::fs::File,
}

impl Drop for BridgeProcessLock {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

async fn acquire_bridge_process_lock(runtime: &Path) -> Result<BridgeProcessLock> {
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

async fn health(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let config = state.proxy.read().await;
    Json(serde_json::json!({
        "ok": true,
        "proxy_configured": !config.url.is_empty(),
        "proxy_mode": if config.url.is_empty() { "embedded" } else { "external" },
        "proxy_model": config.model,
        "proxy_chatgpt_mode": config.chatgpt_mode,
        "bridge": state.bridge.exists(),
    }))
}

async fn get_config(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let config = state.proxy.read().await;
    Json(public_config(&config))
}

async fn update_config(
    State(state): State<Arc<AppState>>,
    Json(update): Json<ConfigUpdate>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let mut config = state.proxy.write().await;
    if let Some(url) = update.url {
        let url = url.trim().to_owned();
        if !url.is_empty() && !(url.starts_with("http://") || url.starts_with("https://")) {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(
                    serde_json::json!({ "error": "proxy URL must start with http:// or https://" }),
                ),
            ));
        }
        config.url = url.trim_end_matches('/').to_owned();
    }
    if update.clear_api_key.unwrap_or(false) {
        config.api_key = None;
    } else if let Some(api_key) = update.api_key.filter(|value| !value.trim().is_empty()) {
        config.api_key = Some(api_key.trim().to_owned());
    }
    if let Some(model) = update.model {
        config.model = model.trim().to_owned();
    }
    if let Some(mode) = update.chatgpt_mode {
        let mode = mode.trim().to_owned();
        if !["auto", "web"].contains(&mode.as_str()) {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": "chatgpt_mode must be auto or web" })),
            ));
        }
        config.chatgpt_mode = mode;
    }
    if let Some(think) = update.chatgpt_think {
        config.chatgpt_think = think;
    }
    if let Some(session_id) = update.session_id {
        config.session_id = (!session_id.trim().is_empty()).then(|| session_id.trim().to_owned());
    }
    if let Some(hotkey) = update.hotkey {
        let hotkey = hotkey.trim().to_owned();
        if hotkey.len() > 80 {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": "hotkey must contain at most 80 characters" })),
            ));
        }
        let previous = config.hotkey.clone();
        if hotkey != previous {
            if !previous.is_empty() {
                unregister_hotkey(&state.app, &previous).map_err(|error| (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({ "error": format!("could not unregister hotkey: {error}") })),
                ))?;
            }
            if !hotkey.is_empty() {
                let port = env::var("SCREEN_AGENT_PORT")
                    .ok()
                    .and_then(|value| value.parse().ok())
                    .unwrap_or(8787);
                if let Err(error) = register_hotkey(&state.app, &hotkey, port) {
                    if !previous.is_empty() {
                        let _ = register_hotkey(&state.app, &previous, port);
                    }
                    return Err((
                        StatusCode::BAD_REQUEST,
                        Json(
                            serde_json::json!({ "error": format!("could not register hotkey: {error}") }),
                        ),
                    ));
                }
            }
            config.hotkey = hotkey;
        }
    }
    if let Some(enabled) = update.imglink_upload {
        config.imglink_upload = enabled;
    }
    if update.clear_imglink_api_key.unwrap_or(false) {
        config.imglink_api_key = None;
    } else if let Some(api_key) = update
        .imglink_api_key
        .filter(|value| !value.trim().is_empty())
    {
        config.imglink_api_key = Some(api_key.trim().to_owned());
    }
    let snapshot = config.clone();
    drop(config);
    if let Err(error) = save_config(&state.runtime.join("config.json"), &snapshot).await {
        return Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": error.to_string() })),
        ));
    }
    // Config is baked into the bridge's env at spawn, so drop the warm bridge;
    // the next capture respawns it with the new model/session/proxy settings.
    close_agent_bridge(&state).await;
    Ok(Json(public_config(&snapshot)))
}

fn public_config(config: &ProxyConfig) -> serde_json::Value {
    serde_json::json!({
        "url": config.url,
        "mode": if config.url.is_empty() { "embedded" } else { "external" },
        "api_key_configured": config.api_key.is_some(),
        "model": config.model,
        "chatgpt_mode": config.chatgpt_mode,
        "chatgpt_think": config.chatgpt_think,
        "session_id": config.session_id,
        "hotkey": config.hotkey,
        "hotkey_backend": if wayland_hyprland() { "hyprland" } else { "tauri" },
        "imglink_upload": config.imglink_upload,
        "imglink_api_key_configured": config.imglink_api_key.is_some(),
    })
}

async fn events(
    State(state): State<Arc<AppState>>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let receiver = state.events.subscribe();
    let stream = BroadcastStream::new(receiver).filter_map(|item| async move {
        match item {
            Ok(message) => Some(Ok(Event::default()
                .event(message.event)
                .json_data(message.data)
                .unwrap_or_else(|_| Event::default()))),
            Err(_) => None,
        }
    });
    Sse::new(stream).keep_alive(KeepAlive::default())
}

async fn capture(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    trigger_desktop_capture(state.app.clone());
    Json(serde_json::json!({ "status": "queued" }))
}

async fn run(
    State(state): State<Arc<AppState>>,
    Json(request): Json<RunRequest>,
) -> Result<(StatusCode, Json<RunResponse>), (StatusCode, Json<serde_json::Value>)> {
    let prompt = prompt_with_short_answer(request.prompt.trim().to_owned());
    if prompt.is_empty() || prompt.len() > 4000 {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "prompt must contain 1-4000 characters" })),
        ));
    }
    let run_id = Uuid::new_v4();
    let _ = state.events.send(AgentEvent {
        event: "run.queued".to_owned(),
        data: serde_json::json!({ "run_id": run_id }),
    });
    tokio::spawn(run_agent(
        state,
        run_id,
        request.url,
        prompt,
        request.web_search,
    ));
    Ok((
        StatusCode::ACCEPTED,
        Json(RunResponse {
            run_id,
            status: "queued",
        }),
    ))
}

async fn run_agent(
    state: Arc<AppState>,
    run_id: Uuid,
    url: String,
    prompt: String,
    web_search: bool,
) {
    let result = run_bridge(&state, run_id, url, prompt, web_search).await;
    match result {
        Ok(output) => publish_success(&state, run_id, output).await,
        Err(error) => {
            tracing::error!(%run_id, %error, "agent run failed");
            let _ = state.events.send(AgentEvent {
                event: "run.failed".to_owned(),
                data: serde_json::json!({ "run_id": run_id, "error": error.to_string() }),
            });
        }
    }
}

async fn publish_success(state: &AppState, run_id: Uuid, output: serde_json::Value) {
    let _ = state.events.send(AgentEvent {
        event: "capture.ready".to_owned(),
        data: serde_json::json!({
            "run_id": run_id,
            "url": output["url"],
            "title": output["title"],
            "screenshot": output["screenshot"],
            "screenshot_size": output["screenshot_size"],
            "viewport": output["viewport"],
            "elements": output["elements"],
            "images": output["images"],
            "image_upload": output["image_upload"],
            "image_analyzed": output["image_analyzed"],
            "web_search": output["web_search"],
        }),
    });
    let answer = output
        .get("answer")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("No answer returned.");
    let short_answer = short_answer(answer);
    let _ = state.events.send(AgentEvent {
        event: "answer.ready".to_owned(),
        data: serde_json::json!({ "run_id": run_id, "answer": answer, "short_answer": short_answer }),
    });
    let body = short_answer;
    let _ = tokio::task::spawn_blocking(move || {
        Notification::new()
            .summary("Screen Agent answer")
            .body(&body)
            .show()
    })
    .await;
}

fn trigger_desktop_capture(app: tauri::AppHandle) {
    let Some(state) = app.try_state::<Arc<AppState>>() else {
        return;
    };
    let state = Arc::clone(&*state);
    if state.capture_busy.swap(true, Ordering::AcqRel) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let run_id = Uuid::new_v4();
        let result = capture_desktop(&state, run_id).await;
        state.capture_busy.store(false, Ordering::Release);
        match result {
            Ok(output) => publish_success(&state, run_id, output).await,
            Err(error) => {
                tracing::error!(%run_id, %error, "desktop capture failed");
                let _ = state.events.send(AgentEvent {
                    event: "run.failed".to_owned(),
                    data: serde_json::json!({ "run_id": run_id, "error": error.to_string() }),
                });
            }
        }
    });
}

async fn capture_desktop(state: &AppState, run_id: Uuid) -> Result<serde_json::Value> {
    let screenshot_path = state.runtime.join("captures").join(format!("{run_id}.png"));
    let screenshot_url = format!("/captures/{run_id}.png");
    let path = screenshot_path.clone();
    let viewport = tokio::task::spawn_blocking(move || -> Result<serde_json::Value> {
        let monitors = match Monitor::all() {
            Ok(monitors) => monitors,
            Err(error) => {
                #[cfg(target_os = "linux")]
                if StdCommand::new("grim")
                    .arg(&path)
                    .status()
                    .is_ok_and(|status| status.success())
                {
                    return Ok(serde_json::json!({
                        "width": 0,
                        "height": 0,
                        "device_pixel_ratio": 1,
                        "backend": "grim",
                    }));
                }
                return Err(anyhow::anyhow!("enumerate monitors: {error}"));
            }
        };
        let primary = monitors
            .iter()
            .find(|monitor| monitor.is_primary().unwrap_or(false))
            .or_else(|| monitors.first())
            .context("no monitor available")?;
        let image = primary.capture_image().context("capture primary monitor")?;
        let viewport = serde_json::json!({
            "width": image.width(),
            "height": image.height(),
            "device_pixel_ratio": 1,
        });
        image.save(&path).context("write desktop screenshot")?;
        Ok(viewport)
    })
    .await??;
    let prompt = prompt_with_short_answer(
        env::var("SCREEN_AGENT_SCREEN_PROMPT").unwrap_or_else(|_| default_screen_prompt()),
    );
    // Web search adds a slow live lookup; off by default, opt in via env.
    let web_search = env_bool("SCREEN_AGENT_SCREEN_WEB_SEARCH", false);
    agent_request(
        state,
        serde_json::json!({
            "cmd": "analyze_screenshot",
            "run_id": run_id,
            "image_path": screenshot_path,
            "screenshot": screenshot_url,
            "viewport": viewport,
            "prompt": prompt,
            "web_search": web_search,
        }),
        250,
    )
    .await
}

async fn proxy_login(
    State(state): State<Arc<AppState>>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    if !state.proxy.read().await.url.is_empty() {
        return Ok(Json(serde_json::json!({
            "mode": "external",
            "logged_in": true,
            "ready": true,
        })));
    }
    if state
        .login_in_progress
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Ok(Json(serde_json::json!({
            "mode": "embedded",
            "logged_in": false,
            "ready": false,
            "login_in_progress": true,
        })));
    }

    // Free the ChatGPT profile lock the warm capture bridge holds before login
    // tries to claim it.
    close_agent_bridge(&state).await;

    let bridge_process_lock = match acquire_bridge_process_lock(&state.runtime).await {
        Ok(lock) => lock,
        Err(error) => {
            state.login_in_progress.store(false, Ordering::Release);
            return Err((
                StatusCode::CONFLICT,
                Json(serde_json::json!({ "error": error.to_string() })),
            ));
        }
    };
    let config = state.proxy.read().await.clone();
    tracing::info!("starting embedded ChatGPT login bridge");
    let mut child = match bridge_command(&state, &config)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            state.login_in_progress.store(false, Ordering::Release);
            return Err((
                StatusCode::BAD_GATEWAY,
                Json(serde_json::json!({ "error": format!("start login bridge: {error}") })),
            ));
        }
    };

    let stdin = child.stdin.take().expect("login bridge stdin configured");
    let stdout = child.stdout.take().expect("login bridge stdout configured");
    let mut login_bridge = BridgeProcess {
        child,
        stdin,
        stdout: BufReader::new(stdout),
        _process_lock: bridge_process_lock,
    };
    let login_result = tokio::time::timeout(
        Duration::from_secs(60),
        login_bridge.request(serde_json::json!({ "cmd": "login" })),
    )
    .await;
    let login_error = match login_result {
        Ok(Ok(_)) => None,
        Ok(Err(error)) => Some(error.to_string()),
        Err(_) => Some("ChatGPT login window did not start within 20 seconds".to_owned()),
    };
    if let Some(error) = login_error {
        let _ = login_bridge.child.kill().await;
        let _ = login_bridge.child.wait().await;
        state.login_in_progress.store(false, Ordering::Release);
        return Err((
            StatusCode::BAD_GATEWAY,
            Json(serde_json::json!({ "error": format!("start ChatGPT login: {error}") })),
        ));
    }
    *state.login_bridge.lock().await = Some(login_bridge);
    tracing::info!("embedded ChatGPT login window opened");

    Ok(Json(serde_json::json!({
        "mode": "embedded",
        "logged_in": false,
        "ready": false,
        "login_in_progress": true,
        "started": true,
    })))
}

async fn proxy_status(
    State(state): State<Arc<AppState>>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let config = state.proxy.read().await.clone();
    if !config.url.is_empty() {
        return Ok(Json(serde_json::json!({
            "mode": "external",
            "logged_in": true,
            "ready": true,
        })));
    }
    if state.login_in_progress.load(Ordering::Acquire) {
        let mut login_bridge = state.login_bridge.lock().await;
        if let Some(bridge) = login_bridge.as_mut() {
            match tokio::time::timeout(
                Duration::from_secs(8),
                bridge.request(serde_json::json!({ "cmd": "status" })),
            )
            .await
            {
                Ok(Ok(mut value)) => {
                    if let Some(object) = value.as_object_mut() {
                        object.insert(
                            "login_in_progress".to_owned(),
                            serde_json::Value::Bool(true),
                        );
                    }
                    return Ok(Json(value));
                }
                Ok(Err(error)) => {
                    tracing::warn!(%error, "persistent login status failed");
                }
                Err(_) => tracing::warn!("persistent login status timed out"),
            }
        }
        return Ok(Json(serde_json::json!({
            "mode": "embedded",
            "logged_in": false,
            "ready": false,
            "login_in_progress": true,
        })));
    }
    match agent_request(&state, serde_json::json!({ "cmd": "status" }), 30).await {
        Ok(value) => Ok(Json(value)),
        Err(error) => Err((
            StatusCode::BAD_GATEWAY,
            Json(serde_json::json!({ "error": error.to_string() })),
        )),
    }
}

async fn proxy_close_login(
    State(state): State<Arc<AppState>>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    tracing::info!("closing embedded ChatGPT login bridge");
    match close_login_bridge(&state).await {
        Ok(()) => Ok(Json(serde_json::json!({
            "mode": "embedded",
            "closed": true,
            "login_in_progress": false,
        }))),
        Err(error) => Err((
            StatusCode::BAD_GATEWAY,
            Json(serde_json::json!({ "error": error.to_string() })),
        )),
    }
}

async fn close_login_bridge(state: &AppState) -> Result<()> {
    let mut login_bridge = state.login_bridge.lock().await;
    let Some(mut bridge) = login_bridge.take() else {
        state.login_in_progress.store(false, Ordering::Release);
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
    state.login_in_progress.store(false, Ordering::Release);
    result
}

async fn run_bridge(
    state: &AppState,
    run_id: Uuid,
    url: String,
    prompt: String,
    web_search: bool,
) -> Result<serde_json::Value> {
    if state.proxy.read().await.url.is_empty() {
        // agent_request closes any in-progress login and warms the capture bridge.
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

async fn spawn_bridge_process(state: &AppState) -> Result<BridgeProcess> {
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

async fn close_agent_bridge(state: &AppState) {
    if let Some(bridge) = state.agent_bridge.lock().await.take() {
        bridge.shutdown().await;
    }
}

// Send a command to the warm capture bridge, spawning it if needed. On a broken
// pipe or dead process, the bridge is dropped and the command retried once from
// a fresh process. login and the agent bridge can't share the ChatGPT profile,
// so any in-progress login is closed first.
async fn agent_request(
    state: &AppState,
    command: serde_json::Value,
    timeout_secs: u64,
) -> Result<serde_json::Value> {
    let _bridge_guard = state.bridge_busy.lock().await;
    if state.login_in_progress.load(Ordering::Acquire) {
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
        // Request failed: the process may be wedged. Drop it so the next attempt
        // (or caller) starts clean. Only the first failure gets a retry.
        if let Some(bridge) = slot.take() {
            bridge.shutdown().await;
        }
        if attempt == 1 {
            break;
        }
    }
    Err(last_error.unwrap_or_else(|| anyhow::anyhow!("bridge request failed")))
}

fn bridge_command(state: &AppState, config: &ProxyConfig) -> Command {
    let mut child_command = Command::new(node_binary());
    child_command
        .arg(&state.bridge)
        .current_dir(state.bridge.parent().unwrap_or(Path::new(".")))
        .env("SCREEN_AGENT_RUNTIME", &state.runtime)
        .env("GPT_PROXY_MODEL", &config.model)
        .env("GPT_PROXY_CHATGPT_MODE", &config.chatgpt_mode)
        .env(
            "SCREEN_AGENT_CHATGPT_THINK",
            if config.chatgpt_think { "true" } else { "false" },
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

fn create_tray(app: &mut tauri::App) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::TrayIconBuilder;

    let show_item = MenuItem::with_id(app, "show", "Show Screen Agent", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_item, &quit_item])?;
    let mut tray = TrayIconBuilder::new()
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("Screen Agent")
        .on_menu_event(handle_tray_event);
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

fn handle_tray_event(app: &tauri::AppHandle, event: tauri::menu::MenuEvent) {
    match event.id().as_ref() {
        "show" => show_main_window(app),
        "quit" => app.exit(0),
        _ => {}
    }
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn node_binary() -> &'static str {
    if cfg!(windows) {
        "node.exe"
    } else {
        "node"
    }
}

fn env_value(names: &[&str]) -> Option<String> {
    names.iter().find_map(|name| {
        env::var(name)
            .ok()
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty())
    })
}

fn env_bool(name: &str, fallback: bool) -> bool {
    match env::var(name) {
        Ok(value) => !matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "" | "0" | "false" | "no" | "off"
        ),
        Err(_) => fallback,
    }
}

#[cfg(test)]
mod tests {
    use super::{
        acquire_bridge_process_lock, default_screen_prompt, load_saved_config,
        prompt_with_short_answer, save_config, short_answer, ProxyConfig,
    };

    #[test]
    fn short_answer_instruction_and_parser_work() {
        assert!(prompt_with_short_answer("Read image".to_owned())
            .contains("Short Answer: actual concise answer"));
        assert_eq!(
            short_answer("Detailed explanation\nShort Answer: 26 months"),
            "26 months"
        );
        assert_eq!(
            short_answer(
                "Short Answer: \"Short Answer: Q.1) Sim, 60,7 kg. Q.2) 7.000 peças. Q.3) Enunciado incompleto\""
            ),
            "Q.1) Sim, 60,7 kg. Q.2) 7.000 peças. Q.3) Enunciado incompleto"
        );
        assert!(default_screen_prompt().contains("Short Answer:"));
        assert!(default_screen_prompt().contains("Do not describe the browser"));
        assert!(default_screen_prompt().contains("step by step"));
    }

    #[tokio::test]
    async fn proxy_config_round_trips_to_disk() {
        let path = std::env::temp_dir().join(format!("screen-agent-{}.json", uuid::Uuid::new_v4()));
        let config = ProxyConfig {
            url: "http://127.0.0.1:9000".to_owned(),
            api_key: Some("proxy-secret".to_owned()),
            model: "chatgpt:chatgpt-web-session".to_owned(),
            chatgpt_mode: "web".to_owned(),
            chatgpt_think: false,
            session_id: Some("screen-agent".to_owned()),
            hotkey: "CommandOrControl+Shift+S".to_owned(),
            imglink_upload: true,
            imglink_api_key: Some("imglink-secret".to_owned()),
        };
        save_config(&path, &config).await.expect("save config");
        assert_eq!(
            load_saved_config(&path).await.map(|value| value.url),
            Some(config.url)
        );
        let _ = tokio::fs::remove_file(path).await;
    }

    #[tokio::test]
    async fn bridge_process_lock_is_released() {
        let runtime =
            std::env::temp_dir().join(format!("screen-agent-lock-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&runtime)
            .await
            .expect("create runtime");
        {
            let _lock = acquire_bridge_process_lock(&runtime)
                .await
                .expect("acquire bridge lock");
            assert!(runtime.join("bridge-process.lock").exists());
        }
        assert!(!runtime.join("bridge-process.lock").exists());
        let _ = tokio::fs::remove_dir_all(runtime).await;
    }
}
