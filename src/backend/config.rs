use anyhow::{Context, Result};
use serde_json::Value;
use std::{env, path::Path};

use super::{
    platform::wayland_hyprland,
    state::{default_chat_hotkey, default_image_upload_providers, ProxyConfig},
};

pub(crate) fn prompt_with_short_answer(prompt: String) -> String {
    if prompt.to_ascii_lowercase().contains("short answer:") {
        prompt
    } else {
        format!(
            "{prompt}\n\nEnd with exactly one final line: Short Answer: actual concise answer. Do not repeat the label or use quotation marks."
        )
    }
}

pub(crate) fn prepare_run_prompt(prompt: String) -> Result<String, &'static str> {
    let raw_prompt = prompt.trim();
    if raw_prompt.is_empty() {
        return Err("prompt must contain 1-4000 characters");
    }
    let prompt = prompt_with_short_answer(raw_prompt.to_owned());
    if prompt.len() > 4000 {
        return Err("prompt must contain 1-4000 characters");
    }
    Ok(prompt)
}

pub(crate) fn prepare_chat_prompt(prompt: String) -> Result<String, &'static str> {
    let prompt = prompt.trim().to_owned();
    if prompt.is_empty() || prompt.len() > 4000 {
        return Err("message must contain 1-4000 characters");
    }
    Ok(prompt)
}

pub(crate) fn default_screen_prompt() -> String {
    "Read the uploaded desktop screenshot and find every question, problem, or exercise in it. Solve each one and actually work it out: read the given values, do the calculations or reasoning step by step, and reach a correct result — never guess or leave a question unanswered. Preserve the visible numbering (Q.1, Q.2, and Q.1.a) for subparts). Use only text that is actually readable in the image; do not invent missing text, and if part of a problem is unreadable, say so for that item. Do not describe the browser, the page layout, or the screenshot itself — spend the output on solving. If the screenshot is a coding or programming task (code editor, function stub, algorithm prompt, LeetCode problem, failing test, or similar), first identify the programming language actually shown on screen — infer it from the visible syntax, the file name or extension, the editor, or the problem statement — then write the COMPLETE solution in that exact same language: the full code, ready to paste in and run. Do not abbreviate, summarize, omit imports or boilerplate, or leave placeholders, TODOs, or '...' — output the whole program or function. For a coding task the delivered answer must be the code itself, so keep any explanation to at most one short line, then end with the single line 'Short Answer:' and, on the very next line, 'LANG: ' followed by the detected language name (for example 'LANG: C++'), and on the line after that the entire finished code in that language, written as raw code with no markdown code fences or backticks and nothing after it. If no question is present, give one concise, useful answer about the visible content. Otherwise end with exactly one final line: Short Answer: the concise result for each item (for example Q.1) 42, Q.2) yes). Do not repeat the label or wrap the answer in quotation marks.".to_owned()
}

pub(crate) fn short_answer(answer: &str) -> String {
    let marker = answer
        .to_ascii_lowercase()
        .rfind("short answer:")
        .map(|index| index + "Short Answer:".len());
    let value = marker
        .map(|index| answer[index..].trim())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| answer.trim());
    value
        .trim()
        .trim_matches(|character| matches!(character, '"' | '\'' | '`'))
        .trim()
        .to_owned()
}

pub(crate) fn parse_code_answer(short: &str) -> Option<(String, String)> {
    let short = short.trim();
    let lang_start = short.find("LANG:").or_else(|| short.find("lang:"))?;
    let rest = &short[lang_start + "LANG:".len()..];
    let (lang_line, code) = rest.split_once('\n')?;
    let code = code
        .trim()
        .trim_matches(|character| matches!(character, '"' | '\'' | '`'))
        .trim();
    (!code.is_empty()).then(|| (lang_line.trim().to_owned(), code.to_owned()))
}

pub(crate) fn proxy_config_from_env() -> ProxyConfig {
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
        hotkey: env::var("SCREEN_AGENT_HOTKEY")
            .map(|value| value.trim().to_owned())
            .unwrap_or_else(|_| "CommandOrControl+Shift+S".to_owned()),
        chat_hotkey: env::var("SCREEN_AGENT_CHAT_HOTKEY")
            .map(|value| value.trim().to_owned())
            .unwrap_or_else(|_| default_chat_hotkey()),
        imglink_upload: env_bool("SCREEN_AGENT_IMGLINK_UPLOAD", false),
        imglink_api_key: env_value(&["SCREEN_AGENT_IMGLINK_API_KEY", "IMGLINK_API_KEY"]),
        image_upload_providers: env_value(&["SCREEN_AGENT_IMAGE_UPLOAD_PROVIDERS"])
            .unwrap_or_else(default_image_upload_providers),
        imgpile_api_token: env_value(&["SCREEN_AGENT_IMGPILE_API_TOKEN", "IMGPILE_API_TOKEN"]),
        postimages_api_token: env_value(&[
            "SCREEN_AGENT_POSTIMAGES_API_TOKEN",
            "SCREEN_AGENT_POSTIMAGES_API_KEY",
            "POSTIMAGES_API_TOKEN",
            "POSTIMAGES_API_KEY",
        ]),
        imgbb_api_key: env_value(&["SCREEN_AGENT_IMGBB_API_KEY", "IMGBB_API_KEY"]),
        code_delivery: env_value(&["SCREEN_AGENT_CODE_DELIVERY"])
            .filter(|value| matches!(value.as_str(), "notify" | "overlay" | "type"))
            .unwrap_or_else(|| "notify".to_owned()),
    }
}

pub(crate) async fn load_saved_config(path: &Path) -> Option<ProxyConfig> {
    let bytes = tokio::fs::read(path).await.ok()?;
    match serde_json::from_slice(&bytes) {
        Ok(config) => Some(config),
        Err(error) => {
            tracing::warn!(path = %path.display(), %error, "ignoring invalid saved config");
            None
        }
    }
}

pub(crate) async fn save_config(path: &Path, config: &ProxyConfig) -> Result<()> {
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

pub(crate) fn public_config(config: &ProxyConfig) -> Value {
    serde_json::json!({
        "url": config.url,
        "mode": if config.url.is_empty() { "embedded" } else { "external" },
        "api_key_configured": config.api_key.is_some(),
        "model": config.model,
        "chatgpt_mode": config.chatgpt_mode,
        "chatgpt_think": config.chatgpt_think,
        "session_id": config.session_id,
        "hotkey": config.hotkey,
        "chat_hotkey": config.chat_hotkey,
        "hotkey_backend": if wayland_hyprland() { "hyprland" } else { "tauri" },
        "imglink_upload": config.imglink_upload,
        "imglink_api_key_configured": config.imglink_api_key.is_some(),
        "image_upload_providers": config.image_upload_providers,
        "imgpile_api_token_configured": config.imgpile_api_token.is_some(),
        "postimages_api_token_configured": config.postimages_api_token.is_some(),
        "imgbb_api_key_configured": config.imgbb_api_key.is_some(),
        "code_delivery": config.code_delivery,
    })
}

pub(crate) fn env_value(names: &[&str]) -> Option<String> {
    names.iter().find_map(|name| {
        env::var(name)
            .ok()
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty())
    })
}

pub(crate) fn env_bool(name: &str, fallback: bool) -> bool {
    match env::var(name) {
        Ok(value) => !matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "" | "0" | "false" | "no" | "off"
        ),
        Err(_) => fallback,
    }
}
