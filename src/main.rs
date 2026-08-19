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
use std::{convert::Infallible, env, net::SocketAddr, path::PathBuf, sync::Arc};
use tokio::{io::AsyncWriteExt, process::Command, sync::broadcast};
use tokio_stream::wrappers::BroadcastStream;
use tower_http::{cors::CorsLayer, services::ServeDir};
use uuid::Uuid;

#[derive(Clone)]
struct AppState {
    events: broadcast::Sender<AgentEvent>,
    bridge: PathBuf,
    runtime: PathBuf,
    proxy_url: Option<String>,
    proxy_api_key: Option<String>,
    proxy_model: String,
    proxy_chatgpt_mode: String,
    proxy_session_id: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
struct AgentEvent {
    event: String,
    data: serde_json::Value,
}

#[derive(Debug, Deserialize)]
struct RunRequest {
    prompt: String,
    #[serde(default = "default_url")]
    url: String,
}

#[derive(Serialize)]
struct RunResponse {
    run_id: Uuid,
    status: &'static str,
}

fn default_url() -> String {
    "https://example.com".to_owned()
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt::init();

    let port = env::var("SCREEN_AGENT_PORT")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(8787);
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let runtime = root.join(".runtime");
    tokio::fs::create_dir_all(runtime.join("captures")).await?;
    let (event_tx, _) = broadcast::channel(64);

    let hub_url = env_value(&["RUST_PROXY_HUB_URL"]);
    let proxy_url = hub_url.clone().or_else(|| env_value(&["GPT_PROXY_URL"]));
    let proxy_api_key = env_value(&["RUST_PROXY_HUB_API_KEY", "GPT_PROXY_API_KEY"]);
    let proxy_model =
        env_value(&["RUST_PROXY_HUB_MODEL", "GPT_PROXY_MODEL"]).unwrap_or_else(|| {
            if hub_url.is_some() {
                "chatgpt:chatgpt-web-session".to_owned()
            } else {
                "screen-agent".to_owned()
            }
        });
    let proxy_chatgpt_mode = env_value(&["RUST_PROXY_HUB_CHATGPT_MODE", "GPT_PROXY_CHATGPT_MODE"])
        .unwrap_or_else(|| "web".to_owned());
    let proxy_session_id = env_value(&["RUST_PROXY_HUB_SESSION_ID", "GPT_PROXY_SESSION_ID"]);

    let state = AppState {
        events: event_tx,
        bridge: root.join("bridge/index.mjs"),
        runtime: runtime.clone(),
        proxy_url,
        proxy_api_key,
        proxy_model,
        proxy_chatgpt_mode,
        proxy_session_id,
    };

    let cors = CorsLayer::new()
        .allow_origin(tower_http::cors::Any)
        .allow_methods([Method::GET, Method::POST])
        .allow_headers([header::CONTENT_TYPE]);
    let app = Router::new()
        .route("/api/health", get(health))
        .route("/api/events", get(events))
        .route("/api/run", post(run))
        .nest_service("/captures", ServeDir::new(runtime.join("captures")))
        .layer(cors)
        .with_state(Arc::new(state));

    let address = SocketAddr::from(([127, 0, 0, 1], port));
    tracing::info!(%address, "screen-agent listening");
    let listener = tokio::net::TcpListener::bind(address).await?;
    axum::serve(listener, app).await?;
    Ok(())
}

async fn health(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "ok": true,
        "proxy_configured": state.proxy_url.is_some(),
        "proxy_model": state.proxy_model,
        "proxy_chatgpt_mode": state.proxy_chatgpt_mode,
        "bridge": state.bridge.exists(),
    }))
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

async fn run(
    State(state): State<Arc<AppState>>,
    Json(request): Json<RunRequest>,
) -> Result<(StatusCode, Json<RunResponse>), (StatusCode, Json<serde_json::Value>)> {
    let prompt = request.prompt.trim().to_owned();
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
    tokio::spawn(run_agent(state, run_id, request.url, prompt));
    Ok((
        StatusCode::ACCEPTED,
        Json(RunResponse {
            run_id,
            status: "queued",
        }),
    ))
}

async fn run_agent(state: Arc<AppState>, run_id: Uuid, url: String, prompt: String) {
    let result = run_bridge(&state, run_id, url, prompt).await;
    match result {
        Ok(output) => {
            let _ = state.events.send(AgentEvent {
                event: "capture.ready".to_owned(),
                data: serde_json::json!({
                    "run_id": run_id,
                    "url": output["url"],
                    "title": output["title"],
                    "screenshot": output["screenshot"],
                }),
            });
            let answer = output
                .get("answer")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("No answer returned.");
            let _ = state.events.send(AgentEvent {
                event: "answer.ready".to_owned(),
                data: serde_json::json!({ "run_id": run_id, "answer": answer }),
            });
            let body = answer.chars().take(240).collect::<String>();
            let _ = tokio::task::spawn_blocking(move || {
                Notification::new()
                    .summary("Screen Agent answer")
                    .body(&body)
                    .show()
            })
            .await;
        }
        Err(error) => {
            tracing::error!(%run_id, %error, "agent run failed");
            let _ = state.events.send(AgentEvent {
                event: "run.failed".to_owned(),
                data: serde_json::json!({ "run_id": run_id, "error": error.to_string() }),
            });
        }
    }
}

async fn run_bridge(
    state: &AppState,
    run_id: Uuid,
    url: String,
    prompt: String,
) -> Result<serde_json::Value> {
    let mut child_command = Command::new(node_binary());
    child_command
        .arg(&state.bridge)
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .env("SCREEN_AGENT_RUNTIME", &state.runtime)
        .env("GPT_PROXY_MODEL", &state.proxy_model)
        .env("GPT_PROXY_CHATGPT_MODE", &state.proxy_chatgpt_mode);
    if let Some(url) = &state.proxy_url {
        child_command.env("GPT_PROXY_URL", url);
    }
    if let Some(key) = &state.proxy_api_key {
        child_command.env("GPT_PROXY_API_KEY", key);
    }
    if let Some(session_id) = &state.proxy_session_id {
        child_command.env("GPT_PROXY_SESSION_ID", session_id);
    }
    let mut child = child_command
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .context("start Playwright bridge; install Node.js and bridge dependencies")?;
    let command = serde_json::json!({
        "cmd": "analyze",
        "run_id": run_id,
        "url": url,
        "prompt": prompt,
    });
    child
        .stdin
        .take()
        .context("open bridge stdin")?
        .write_all(format!("{command}\n").as_bytes())
        .await?;
    let output = child.wait_with_output().await?;
    if !output.status.success() {
        anyhow::bail!(
            "bridge exited {}: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr)
        );
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let line = stdout
        .lines()
        .filter(|line| !line.trim().is_empty())
        .last()
        .context("bridge returned no JSON")?;
    let value: serde_json::Value = serde_json::from_str(line).context("parse bridge JSON")?;
    if value.get("error").is_some() {
        anyhow::bail!("{}", value["error"]);
    }
    Ok(value)
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
