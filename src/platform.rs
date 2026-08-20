use anyhow::{Context, Result};
use std::{env, process::Command as StdCommand};
use tauri::Manager;
use tauri_plugin_global_shortcut::GlobalShortcutExt;

pub(crate) fn wayland_hyprland() -> bool {
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
    let modifiers = parts
        .into_iter()
        .map(|modifier| match modifier.to_ascii_lowercase().as_str() {
            "commandorcontrol" | "command" | "super" | "meta" | "win" => Ok("SUPER"),
            "control" | "ctrl" => Ok("CTRL"),
            "alt" | "option" => Ok("ALT"),
            "shift" => Ok("SHIFT"),
            other => Err(anyhow::anyhow!("unsupported Hyprland modifier: {other}")),
        })
        .collect::<Result<Vec<_>>>()?;
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

pub(crate) fn register_hotkey(app: &tauri::AppHandle, hotkey: &str, port: u16) -> Result<()> {
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

pub(crate) fn unregister_hotkey(app: &tauri::AppHandle, hotkey: &str) -> Result<()> {
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
pub(crate) fn configure_linux_display() {
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
pub(crate) fn configure_linux_display() {}

#[cfg(target_os = "linux")]
pub(crate) fn suppress_ayatana_deprecation_warning() {
    glib::log_set_handler(
        Some("libayatana-appindicator"),
        glib::LogLevels::LEVEL_WARNING,
        false,
        false,
        |_domain, _level, _message| {},
    );
}

#[cfg(not(target_os = "linux"))]
pub(crate) fn suppress_ayatana_deprecation_warning() {}

pub(crate) fn create_tray(app: &mut tauri::App) -> tauri::Result<()> {
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
