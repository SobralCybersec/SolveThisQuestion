use axum::{extract::State, http::StatusCode, Json};
use std::sync::Arc;
use uuid::Uuid;

use super::{
    bridge::chat_bridge,
    capture::toggle_chat_overlay,
    config::prepare_chat_prompt,
    state::{AgentEvent, AppState, ChatRequest, ChatResponse},
};

fn bad_request(message: impl Into<String>) -> (StatusCode, Json<serde_json::Value>) {
    (
        StatusCode::BAD_REQUEST,
        Json(serde_json::json!({ "error": message.into() })),
    )
}

pub(crate) async fn toggle_chat_endpoint(
    State(state): State<Arc<AppState>>,
) -> Json<serde_json::Value> {
    toggle_chat_overlay(state.app.clone());
    Json(serde_json::json!({ "status": "toggled" }))
}

pub(crate) async fn chat(
    State(state): State<Arc<AppState>>,
    Json(mut request): Json<ChatRequest>,
) -> Result<(StatusCode, Json<ChatResponse>), (StatusCode, Json<serde_json::Value>)> {
    request.prompt = prepare_chat_prompt(request.prompt).map_err(bad_request)?;
    request.history = request
        .history
        .into_iter()
        .filter(|message| matches!(message.role.as_str(), "user" | "assistant"))
        .filter_map(|mut message| {
            message.content = message.content.trim().chars().take(8000).collect();
            (!message.content.is_empty()).then_some(message)
        })
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .take(40)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    let message_id = Uuid::new_v4();
    let _ = state.events.send(AgentEvent {
        event: "chat.queued".to_owned(),
        data: serde_json::json!({ "message_id": message_id }),
    });
    let _ = state.events.send(AgentEvent {
        event: "chat.thinking".to_owned(),
        data: serde_json::json!({ "message_id": message_id }),
    });
    tokio::spawn(chat_agent(state, request, message_id));
    Ok((
        StatusCode::ACCEPTED,
        Json(ChatResponse {
            message_id,
            status: "queued",
        }),
    ))
}

async fn chat_agent(state: Arc<AppState>, request: ChatRequest, message_id: Uuid) {
    match chat_bridge(&state, &request).await {
        Ok(output) => {
            let content = output["text"].as_str().unwrap_or_default().trim();
            if content.is_empty() {
                let _ = state.events.send(AgentEvent {
                    event: "chat.failed".to_owned(),
                    data: serde_json::json!({ "message_id": message_id, "error": "Chat returned an empty answer" }),
                });
                return;
            }
            let _ = state.events.send(AgentEvent {
                event: "chat.message".to_owned(),
                data: serde_json::json!({
                    "message_id": message_id,
                    "content": content,
                    "reasoning_content": output["reasoning_content"],
                }),
            });
        }
        Err(error) => {
            tracing::error!(message_id = %message_id, %error, "chat request failed");
            let _ = state.events.send(AgentEvent {
                event: "chat.failed".to_owned(),
                data: serde_json::json!({ "message_id": message_id, "error": error.to_string() }),
            });
        }
    }
}
