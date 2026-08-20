use anyhow::Result;
use axum::{
    extract::State,
    http::{header, Method, StatusCode},
    response::sse::{Event, KeepAlive, Sse},
    routing::{get, post},
    Json, Router,
};
use futures_util::{stream::Stream, StreamExt};
use std::{convert::Infallible, env, net::SocketAddr, sync::Arc};
use tauri::Manager;
use tokio::sync::{broadcast, Mutex, RwLock};
use tokio_stream::wrappers::BroadcastStream;
use tower_http::{cors::CorsLayer, services::ServeDir};
use uuid::Uuid;

use crate::{
    bridge::{agent_request, close_agent_bridge, close_login_bridge, run_bridge},
    capture::{publish_success, trigger_desktop_capture},
    config::{
        load_saved_config, prepare_run_prompt, proxy_config_from_env, public_config, save_config,
    },
    platform::{register_hotkey, unregister_hotkey},
    state::{AgentEvent, AppState, ConfigUpdate, ProxyConfig, RunRequest, RunResponse},
};

pub(crate) async fn run_server(
    app: tauri::AppHandle,
    bridge: std::path::PathBuf,
    runtime: std::path::PathBuf,
) -> Result<()> {
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
        login_in_progress: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        login_bridge: Arc::new(Mutex::new(None)),
        agent_bridge: Arc::new(Mutex::new(None)),
        capture_busy: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        overlay_payload: Arc::new(std::sync::Mutex::new(None)),
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

fn bad_request(message: impl Into<String>) -> (StatusCode, Json<serde_json::Value>) {
    (
        StatusCode::BAD_REQUEST,
        Json(serde_json::json!({ "error": message.into() })),
    )
}

fn validate_url(url: &str) -> Result<(), String> {
    if url.is_empty() || url.starts_with("http://") || url.starts_with("https://") {
        Ok(())
    } else {
        Err("proxy URL must start with http:// or https://".to_owned())
    }
}

fn apply_connection_config(config: &mut ProxyConfig, update: &ConfigUpdate) -> Result<(), String> {
    if let Some(url) = &update.url {
        let url = url.trim();
        validate_url(url)?;
        config.url = url.trim_end_matches('/').to_owned();
    }
    if update.clear_api_key.unwrap_or(false) {
        config.api_key = None;
    } else if let Some(api_key) = update
        .api_key
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        config.api_key = Some(api_key.trim().to_owned());
    }
    if let Some(model) = &update.model {
        config.model = model.trim().to_owned();
    }
    if let Some(mode) = &update.chatgpt_mode {
        let mode = mode.trim();
        if !["auto", "web"].contains(&mode) {
            return Err("chatgpt_mode must be auto or web".to_owned());
        }
        config.chatgpt_mode = mode.to_owned();
    }
    if let Some(think) = update.chatgpt_think {
        config.chatgpt_think = think;
    }
    if let Some(session_id) = &update.session_id {
        config.session_id = (!session_id.trim().is_empty()).then(|| session_id.trim().to_owned());
    }
    Ok(())
}

fn apply_delivery_config(config: &mut ProxyConfig, update: &ConfigUpdate) {
    if let Some(enabled) = update.imglink_upload {
        config.imglink_upload = enabled;
    }
    if let Some(mode) = &update.code_delivery {
        if matches!(mode.as_str(), "notify" | "overlay" | "type") {
            config.code_delivery = mode.clone();
        }
    }
    if update.clear_imglink_api_key.unwrap_or(false) {
        config.imglink_api_key = None;
    } else if let Some(api_key) = update
        .imglink_api_key
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        config.imglink_api_key = Some(api_key.trim().to_owned());
    }
}

fn apply_simple_config(config: &mut ProxyConfig, update: &ConfigUpdate) -> Result<(), String> {
    apply_connection_config(config, update)?;
    apply_delivery_config(config, update);
    Ok(())
}

async fn apply_hotkey(
    state: &AppState,
    config: &mut ProxyConfig,
    hotkey: &str,
) -> Result<(), String> {
    if hotkey.len() > 80 {
        return Err("hotkey must contain at most 80 characters".to_owned());
    }
    let previous = config.hotkey.clone();
    if hotkey == previous {
        return Ok(());
    }
    if !previous.is_empty() {
        unregister_hotkey(&state.app, &previous)
            .map_err(|error| format!("could not unregister hotkey: {error}"))?;
    }
    if !hotkey.is_empty() {
        let port = env::var("SCREEN_AGENT_PORT")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(8787);
        if let Err(error) = register_hotkey(&state.app, hotkey, port) {
            if !previous.is_empty() {
                let _ = register_hotkey(&state.app, &previous, port);
            }
            return Err(format!("could not register hotkey: {error}"));
        }
    }
    config.hotkey = hotkey.to_owned();
    Ok(())
}

async fn update_config(
    State(state): State<Arc<AppState>>,
    Json(update): Json<ConfigUpdate>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let mut config = state.proxy.write().await;
    apply_simple_config(&mut config, &update).map_err(bad_request)?;
    if let Some(hotkey) = update.hotkey.as_deref() {
        apply_hotkey(&state, &mut config, hotkey.trim())
            .await
            .map_err(bad_request)?;
    }
    let snapshot = config.clone();
    drop(config);
    save_config(&state.runtime.join("config.json"), &snapshot)
        .await
        .map_err(|error| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": error.to_string() })),
            )
        })?;
    close_agent_bridge(&state).await;
    Ok(Json(public_config(&snapshot)))
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
    let prompt = prepare_run_prompt(request.prompt).map_err(bad_request)?;
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
    match run_bridge(&state, run_id, url, prompt, web_search).await {
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

fn reset_login(state: &AppState) {
    state
        .login_in_progress
        .store(false, std::sync::atomic::Ordering::Release);
}

fn external_login() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "mode": "external", "logged_in": true, "ready": true }))
}

fn busy_login() -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "mode": "embedded", "logged_in": false, "ready": false, "login_in_progress": true,
    }))
}

async fn start_login_bridge(
    state: &Arc<AppState>,
) -> Result<crate::bridge::BridgeProcess, (StatusCode, Json<serde_json::Value>)> {
    let process_lock = crate::bridge::acquire_bridge_process_lock(&state.runtime)
        .await
        .map_err(|error| {
            reset_login(state);
            (
                StatusCode::CONFLICT,
                Json(serde_json::json!({ "error": error.to_string() })),
            )
        })?;
    let config = state.proxy.read().await.clone();
    let mut child = crate::bridge::bridge_command(state, &config)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| {
            reset_login(state);
            (
                StatusCode::BAD_GATEWAY,
                Json(serde_json::json!({ "error": format!("start login bridge: {error}") })),
            )
        })?;
    let stdin = child.stdin.take().expect("login bridge stdin configured");
    let stdout = child.stdout.take().expect("login bridge stdout configured");
    Ok(crate::bridge::BridgeProcess {
        child,
        stdin,
        stdout: tokio::io::BufReader::new(stdout),
        _process_lock: process_lock,
    })
}

async fn stop_failed_login(
    state: &Arc<AppState>,
    bridge: &mut crate::bridge::BridgeProcess,
    error: String,
) -> (StatusCode, Json<serde_json::Value>) {
    let _ = bridge.child.kill().await;
    let _ = bridge.child.wait().await;
    reset_login(state);
    (
        StatusCode::BAD_GATEWAY,
        Json(serde_json::json!({ "error": format!("start ChatGPT login: {error}") })),
    )
}

async fn proxy_login(
    State(state): State<Arc<AppState>>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    if !state.proxy.read().await.url.is_empty() {
        return Ok(external_login());
    }
    if state
        .login_in_progress
        .compare_exchange(
            false,
            true,
            std::sync::atomic::Ordering::AcqRel,
            std::sync::atomic::Ordering::Acquire,
        )
        .is_err()
    {
        return Ok(busy_login());
    }
    close_agent_bridge(&state).await;
    let mut login_bridge = start_login_bridge(&state).await?;
    let login_result = tokio::time::timeout(
        std::time::Duration::from_secs(60),
        login_bridge.request(serde_json::json!({ "cmd": "login" })),
    )
    .await;
    let login_error = match login_result {
        Ok(Ok(_)) => None,
        Ok(Err(error)) => Some(error.to_string()),
        Err(_) => Some("ChatGPT login window did not start within 20 seconds".to_owned()),
    };
    if let Some(error) = login_error {
        return Err(stop_failed_login(&state, &mut login_bridge, error).await);
    }
    *state.login_bridge.lock().await = Some(login_bridge);
    tracing::info!("embedded ChatGPT login window opened");
    Ok(Json(serde_json::json!({
        "mode": "embedded", "logged_in": false, "ready": false, "login_in_progress": true, "started": true,
    })))
}

async fn proxy_status(
    State(state): State<Arc<AppState>>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let config = state.proxy.read().await.clone();
    if !config.url.is_empty() {
        return Ok(Json(
            serde_json::json!({ "mode": "external", "logged_in": true, "ready": true }),
        ));
    }
    if state
        .login_in_progress
        .load(std::sync::atomic::Ordering::Acquire)
    {
        let mut login_bridge = state.login_bridge.lock().await;
        if let Some(bridge) = login_bridge.as_mut() {
            match tokio::time::timeout(
                std::time::Duration::from_secs(8),
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
                Ok(Err(error)) => tracing::warn!(%error, "persistent login status failed"),
                Err(_) => tracing::warn!("persistent login status timed out"),
            }
        }
        return Ok(Json(serde_json::json!({
            "mode": "embedded", "logged_in": false, "ready": false, "login_in_progress": true,
        })));
    }
    agent_request(&state, serde_json::json!({ "cmd": "status" }), 30)
        .await
        .map(Json)
        .map_err(|error| {
            (
                StatusCode::BAD_GATEWAY,
                Json(serde_json::json!({ "error": error.to_string() })),
            )
        })
}

async fn proxy_close_login(
    State(state): State<Arc<AppState>>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    tracing::info!("closing embedded ChatGPT login bridge");
    close_login_bridge(&state)
        .await
        .map(|()| Json(serde_json::json!({ "mode": "embedded", "closed": true, "login_in_progress": false })))
        .map_err(|error| (StatusCode::BAD_GATEWAY, Json(serde_json::json!({ "error": error.to_string() }))))
}
