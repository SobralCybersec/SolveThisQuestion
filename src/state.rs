use serde::{Deserialize, Serialize};
use std::{
    path::PathBuf,
    sync::{atomic::AtomicBool, Arc, Mutex as StdMutex},
};
use tokio::sync::{broadcast, Mutex, RwLock};
use uuid::Uuid;

use crate::bridge::BridgeProcess;

#[derive(Clone)]
pub(crate) struct AppState {
    pub(crate) app: tauri::AppHandle,
    pub(crate) events: broadcast::Sender<AgentEvent>,
    pub(crate) bridge: PathBuf,
    pub(crate) runtime: PathBuf,
    pub(crate) proxy: Arc<RwLock<ProxyConfig>>,
    pub(crate) bridge_busy: Arc<Mutex<()>>,
    pub(crate) login_in_progress: Arc<AtomicBool>,
    pub(crate) login_bridge: Arc<Mutex<Option<BridgeProcess>>>,
    pub(crate) agent_bridge: Arc<Mutex<Option<BridgeProcess>>>,
    pub(crate) capture_busy: Arc<AtomicBool>,
    pub(crate) overlay_payload: Arc<StdMutex<Option<OverlayPayload>>>,
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct AgentEvent {
    pub(crate) event: String,
    pub(crate) data: serde_json::Value,
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct OverlayPayload {
    pub(crate) code: String,
    pub(crate) language: String,
}

#[derive(Debug, Deserialize)]
pub(crate) struct RunRequest {
    pub(crate) prompt: String,
    #[serde(default)]
    pub(crate) web_search: bool,
    #[serde(default = "default_url")]
    pub(crate) url: String,
}

#[derive(Serialize)]
pub(crate) struct RunResponse {
    pub(crate) run_id: Uuid,
    pub(crate) status: &'static str,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct ProxyConfig {
    pub(crate) url: String,
    pub(crate) api_key: Option<String>,
    pub(crate) model: String,
    pub(crate) chatgpt_mode: String,
    #[serde(default)]
    pub(crate) chatgpt_think: bool,
    pub(crate) session_id: Option<String>,
    pub(crate) hotkey: String,
    pub(crate) imglink_upload: bool,
    pub(crate) imglink_api_key: Option<String>,
    #[serde(default = "default_code_delivery")]
    pub(crate) code_delivery: String,
}

#[derive(Debug, Deserialize)]
pub(crate) struct ConfigUpdate {
    pub(crate) url: Option<String>,
    pub(crate) api_key: Option<String>,
    pub(crate) clear_api_key: Option<bool>,
    pub(crate) model: Option<String>,
    pub(crate) chatgpt_mode: Option<String>,
    pub(crate) chatgpt_think: Option<bool>,
    pub(crate) session_id: Option<String>,
    pub(crate) hotkey: Option<String>,
    pub(crate) imglink_upload: Option<bool>,
    pub(crate) imglink_api_key: Option<String>,
    pub(crate) clear_imglink_api_key: Option<bool>,
    pub(crate) code_delivery: Option<String>,
}

fn default_code_delivery() -> String {
    "notify".to_owned()
}

fn default_url() -> String {
    "https://example.com".to_owned()
}
