mod backend;

use std::path::PathBuf;
use tauri::{Manager, WindowEvent};
use tauri_plugin_global_shortcut::ShortcutState;

use crate::backend::server::run_server;
use crate::backend::{
    capture,
    platform::{configure_linux_display, create_tray, suppress_ayatana_deprecation_warning},
};

fn init_logging() {
    configure_linux_display();
    suppress_ayatana_deprecation_warning();
    let log_filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"))
        .add_directive("libwayshot_xcap=off".parse().expect("valid log directive"));
    tracing_subscriber::fmt().with_env_filter(log_filter).init();
}

fn bridge_path(app: &tauri::App) -> anyhow::Result<PathBuf> {
    let source_bridge = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("bridge/index.mjs");
    app.path()
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
        .ok_or_else(|| anyhow::anyhow!("Playwright bridge not found with dependencies"))
}

fn setup_app(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    create_tray(app)?;
    let bridge = bridge_path(app)?;
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
}

fn main() {
    init_logging();

    tauri::Builder::default()
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        capture::trigger_desktop_capture(app.clone());
                    }
                })
                .build(),
        )
        .setup(setup_app)
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![capture::take_overlay_payload])
        .run(tauri::generate_context!())
        .expect("error while running Screen Agent");
}
