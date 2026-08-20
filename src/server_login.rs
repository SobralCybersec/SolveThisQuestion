use super::*;

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

pub(super) async fn proxy_login(
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

pub(super) async fn proxy_status(
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

pub(super) async fn proxy_close_login(
    State(state): State<Arc<AppState>>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    tracing::info!("closing embedded ChatGPT login bridge");
    close_login_bridge(&state)
        .await
        .map(|()| Json(serde_json::json!({ "mode": "embedded", "closed": true, "login_in_progress": false })))
        .map_err(|error| (StatusCode::BAD_GATEWAY, Json(serde_json::json!({ "error": error.to_string() }))))
}
