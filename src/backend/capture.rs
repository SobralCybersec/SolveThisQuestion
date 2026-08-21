use anyhow::{Context, Result};
use notify_rust::{Notification, Timeout};
use std::{env, process::Command as StdCommand, sync::atomic::Ordering};
use tauri::{Emitter, Manager};
use uuid::Uuid;
use xcap::Monitor;

use super::{
    bridge::agent_request,
    config::{
        default_screen_prompt, env_bool, notification_body, parse_code_answer,
        prompt_with_short_answer, short_answer,
    },
    state::{AgentEvent, AppState, OverlayPayload},
};

#[cfg(target_os = "linux")]
fn auto_type(text: &str, clear_first: bool) -> Result<()> {
    let delay = env::var("SCREEN_AGENT_TYPE_DELAY_MS")
        .ok()
        .and_then(|value| value.parse::<u32>().ok())
        .unwrap_or(12)
        .to_string();
    if clear_first {
        let _ = StdCommand::new("wtype")
            .args(["-M", "ctrl", "a", "-m", "ctrl"])
            .status();
        let _ = StdCommand::new("wtype").args(["-k", "Delete"]).status();
    }
    if StdCommand::new("wtype")
        .args(["-d", &delay, "--", text])
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
    {
        return Ok(());
    }
    if clear_first {
        let _ = StdCommand::new("ydotool")
            .args(["key", "29:1", "30:1", "30:0", "29:0"])
            .status();
        let _ = StdCommand::new("ydotool")
            .args(["key", "111:1", "111:0"])
            .status();
    }
    if StdCommand::new("ydotool")
        .args(["type", "--key-delay", &delay, "--", text])
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
    {
        return Ok(());
    }
    Err(anyhow::anyhow!(
        "no auto-typer available — install wtype (Wayland) or ydotool"
    ))
}

#[cfg(not(target_os = "linux"))]
fn auto_type(_text: &str, _clear_first: bool) -> Result<()> {
    Err(anyhow::anyhow!("auto-type is only implemented on Linux"))
}

#[tauri::command]
pub(crate) fn take_overlay_payload(
    state: tauri::State<'_, std::sync::Arc<AppState>>,
) -> Option<OverlayPayload> {
    state.overlay_payload.lock().ok()?.take()
}

async fn show_overlay(state: &AppState, code: &str, language: &str) {
    let payload = OverlayPayload {
        code: code.to_owned(),
        language: language.to_owned(),
    };
    if let Ok(mut pending) = state.overlay_payload.lock() {
        *pending = Some(payload.clone());
    } else {
        tracing::error!("overlay payload lock poisoned");
        return;
    }

    if let Some(window) = state.app.get_webview_window("overlay") {
        let _ = window.emit("overlay.code", &payload);
        let _ = window.set_ignore_cursor_events(true);
        let _ = window.set_focusable(false);
        let _ = window.show();
        return;
    }
    let url = tauri::WebviewUrl::App("index.html?overlay=1".into());
    match tauri::WebviewWindowBuilder::new(&state.app, "overlay", url)
        .title("Screen Agent Overlay")
        .inner_size(600.0, 440.0)
        .always_on_top(true)
        .decorations(false)
        .focusable(false)
        .skip_taskbar(true)
        .build()
    {
        Ok(window) => {
            let _ = window.set_content_protected(true);
            let _ = window.set_ignore_cursor_events(true);
            let _ = window.show();
        }
        Err(error) => tracing::error!(%error, "overlay window build failed"),
    }
}

pub(crate) fn toggle_chat_overlay(app: tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("chat-overlay") {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
        } else {
            let _ = window.show();
            let _ = window.set_focus();
        }
        return;
    }
    let url = tauri::WebviewUrl::App("index.html?chat=1".into());
    match tauri::WebviewWindowBuilder::new(&app, "chat-overlay", url)
        .title("Screen Agent Chat")
        .inner_size(720.0, 640.0)
        .min_inner_size(420.0, 420.0)
        .always_on_top(true)
        .decorations(false)
        .focusable(true)
        .skip_taskbar(true)
        .build()
    {
        Ok(window) => {
            let _ = window.set_focus();
        }
        Err(error) => tracing::error!(%error, "chat overlay window build failed"),
    }
}

async fn notify(summary: &str, body: String) {
    let summary = summary.to_owned();
    let _ = tokio::task::spawn_blocking(move || {
        Notification::new()
            .summary(&summary)
            .body(&body)
            .timeout(notification_timeout())
            .show()
    })
    .await;
}

fn notification_timeout() -> Timeout {
    match env::var("SCREEN_AGENT_NOTIFICATION_TIMEOUT_MS")
        .ok()
        .and_then(|value| value.parse::<u32>().ok())
    {
        Some(0) => Timeout::Never,
        Some(milliseconds) => Timeout::Milliseconds(milliseconds),
        None => Timeout::Milliseconds(30_000),
    }
}

fn capture_event_data(run_id: Uuid, output: &serde_json::Value) -> serde_json::Value {
    serde_json::json!({
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
    })
}

fn answer_event_data(
    run_id: Uuid,
    answer: &str,
    short: &str,
    code: Option<&(String, String)>,
) -> serde_json::Value {
    serde_json::json!({
        "run_id": run_id,
        "answer": answer,
        "short_answer": short,
        "code": code.map(|(_, code)| code),
        "language": code.map(|(language, _)| language),
    })
}

async fn deliver_code(state: &AppState, mode: &str, language: &str, code_text: String) {
    match mode {
        "type" => {
            let clear_first = env_bool("SCREEN_AGENT_TYPE_CLEAR_FIRST", true);
            let typed = code_text.clone();
            let result = tokio::task::spawn_blocking(move || auto_type(&typed, clear_first)).await;
            match result {
                Ok(Ok(())) => {
                    notify("Screen Agent", format!("Auto-typed {language} solution")).await
                }
                _ => {
                    notify(
                        "Screen Agent — auto-type unavailable",
                        "Install wtype (Wayland) or ydotool. Answer is in the app.".to_owned(),
                    )
                    .await
                }
            }
        }
        "overlay" => show_overlay(state, &code_text, language).await,
        _ => notify("Screen Agent answer", code_text).await,
    }
}

pub(crate) async fn publish_success(state: &AppState, run_id: Uuid, output: serde_json::Value) {
    let _ = state.events.send(AgentEvent {
        event: "capture.ready".to_owned(),
        data: capture_event_data(run_id, &output),
    });
    let answer = output
        .get("answer")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("No answer returned.");
    let short = short_answer(answer);
    let code = parse_code_answer(&short);
    let _ = state.events.send(AgentEvent {
        event: "answer.ready".to_owned(),
        data: answer_event_data(run_id, answer, &short, code.as_ref()),
    });

    let mode = state.proxy.read().await.code_delivery.clone();
    if let Some((language, code_text)) = code {
        deliver_code(state, &mode, &language, code_text).await;
    } else {
        notify("Screen Agent answer", notification_body(answer)).await;
    }
}

pub(crate) fn trigger_desktop_capture(app: tauri::AppHandle) {
    let Some(state) = app.try_state::<std::sync::Arc<AppState>>() else {
        return;
    };
    let state = std::sync::Arc::clone(&*state);
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

#[cfg(target_os = "linux")]
fn wlr_capture(path: &std::path::Path) -> Result<serde_json::Value> {
    use libwayshot_xcap::WayshotConnection;
    let conn = WayshotConnection::new().context("wayland screencopy connect")?;
    let cap = conn
        .screenshot_all(false)
        .context("wlr-screencopy capture")?
        .to_rgba8();
    let (width, height) = (cap.width(), cap.height());
    let rgba =
        image::RgbaImage::from_raw(width, height, cap.into_raw()).context("rebuild rgba buffer")?;
    rgba.save(path).context("write desktop screenshot")?;
    Ok(serde_json::json!({
        "width": width,
        "height": height,
        "device_pixel_ratio": 1,
        "backend": "wlr-screencopy",
    }))
}

fn capture_screen(path: &std::path::Path) -> Result<serde_json::Value> {
    #[cfg(target_os = "linux")]
    if env::var_os("WAYLAND_DISPLAY").is_some() {
        match wlr_capture(path) {
            Ok(viewport) => return Ok(viewport),
            Err(error) => tracing::debug!(%error, "wlr-screencopy unavailable, falling back"),
        }
    }
    let monitors = Monitor::all().context("enumerate monitors")?;
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
    image.save(path).context("write desktop screenshot")?;
    Ok(viewport)
}

pub(crate) async fn capture_desktop(state: &AppState, run_id: Uuid) -> Result<serde_json::Value> {
    let screenshot_path = state.runtime.join("captures").join(format!("{run_id}.png"));
    let screenshot_url = format!("/captures/{run_id}.png");
    let path = screenshot_path.clone();
    let viewport = tokio::task::spawn_blocking(move || capture_screen(&path)).await??;
    let prompt = prompt_with_short_answer(
        env::var("SCREEN_AGENT_SCREEN_PROMPT").unwrap_or_else(|_| default_screen_prompt()),
    );
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
