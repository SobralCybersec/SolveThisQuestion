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

#[path = "server_login.rs"]
mod login;

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

    let app = build_router(state, runtime);
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

fn apply_proxy_url(config: &mut ProxyConfig, update: &ConfigUpdate) -> Result<(), String> {
    if let Some(url) = &update.url {
        let url = url.trim();
        validate_url(url)?;
        config.url = url.trim_end_matches('/').to_owned();
    }
    Ok(())
}

fn apply_proxy_api_key(config: &mut ProxyConfig, update: &ConfigUpdate) {
    if update.clear_api_key.unwrap_or(false) {
        config.api_key = None;
    } else if let Some(api_key) = update
        .api_key
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        config.api_key = Some(api_key.trim().to_owned());
    }
}

fn apply_chatgpt_config(config: &mut ProxyConfig, update: &ConfigUpdate) -> Result<(), String> {
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

fn apply_connection_config(config: &mut ProxyConfig, update: &ConfigUpdate) -> Result<(), String> {
    apply_proxy_url(config, update)?;
    apply_proxy_api_key(config, update);
    apply_chatgpt_config(config, update)
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

fn build_router(state: Arc<AppState>, runtime: std::path::PathBuf) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(tower_http::cors::Any)
        .allow_methods([Method::GET, Method::POST, Method::PUT])
        .allow_headers([header::CONTENT_TYPE]);
    Router::new()
        .route("/api/health", get(health))
        .route("/api/config", get(get_config).put(update_config))
        .route("/api/proxy/login", post(login::proxy_login))
        .route("/api/proxy/close-login", post(login::proxy_close_login))
        .route("/api/proxy/status", get(login::proxy_status))
        .route("/api/events", get(events))
        .route("/api/capture", post(capture))
        .route("/api/run", post(run))
        .nest_service("/captures", ServeDir::new(runtime.join("captures")))
        .layer(cors)
        .with_state(state)
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
        crate::bridge::BridgeRunRequest {
            run_id,
            url: request.url,
            prompt,
            web_search: request.web_search,
        },
    ));
    Ok((
        StatusCode::ACCEPTED,
        Json(RunResponse {
            run_id,
            status: "queued",
        }),
    ))
}

async fn run_agent(state: Arc<AppState>, request: crate::bridge::BridgeRunRequest) {
    match run_bridge(&state, &request).await {
        Ok(output) => publish_success(&state, request.run_id, output).await,
        Err(error) => {
            tracing::error!(run_id = %request.run_id, %error, "agent run failed");
            let _ = state.events.send(AgentEvent {
                event: "run.failed".to_owned(),
                data: serde_json::json!({ "run_id": request.run_id, "error": error.to_string() }),
            });
        }
    }
}
