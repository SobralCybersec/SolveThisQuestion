use super::{
    bridge::acquire_bridge_process_lock,
    config::*,
    state::{default_image_upload_providers, ProxyConfig, RunRequest},
};

#[test]
fn parse_code_answer_splits_lang_and_code() {
    let (lang, code) = parse_code_answer("LANG: C++\n#include <vector>\nint main() { return 0; }")
        .expect("code answer");
    assert_eq!(lang, "C++");
    assert!(code.starts_with("#include <vector>"));
    assert!(code.ends_with("return 0; }"));
    assert!(parse_code_answer("42 months").is_none());
    assert!(parse_code_answer("LANG: Python\n   ").is_none());

    let (lang, code) = parse_code_answer(&short_answer(
        "Explanation\n\nShort Answer:\nLANG: Java\nimport java.util.HashMap;\nclass Solution { public int[] twoSum(int[] nums, int target) { return new int[0]; } }",
    )).expect("Java short answer");
    assert_eq!(lang, "Java");
    assert!(code.contains("class Solution"));
}

#[test]
fn short_answer_instruction_and_parser_work() {
    assert!(prompt_with_short_answer("Read image".to_owned())
        .contains("Short Answer: actual concise answer"));
    assert_eq!(
        short_answer("Detailed explanation\nShort Answer: 26 months"),
        "26 months"
    );
    assert_eq!(
        short_answer("Short Answer: \"Short Answer: Q.1) 42\""),
        "Q.1) 42"
    );
    assert!(default_screen_prompt().contains("Short Answer:"));
    assert!(default_screen_prompt().contains("Do not describe the browser"));
}

#[test]
fn run_request_defaults_and_prompt_validation_work() {
    let request: RunRequest = serde_json::from_value(serde_json::json!({
        "prompt": "  Short Answer: ready  "
    }))
    .expect("run request");
    assert!(!request.web_search);
    assert_eq!(request.url, "https://example.com");
    assert_eq!(
        prepare_run_prompt(request.prompt).expect("valid prompt"),
        "Short Answer: ready"
    );
    assert!(prepare_run_prompt("   ".to_owned()).is_err());
    assert!(prepare_run_prompt("x".repeat(4001)).is_err());
}

#[tokio::test]
async fn proxy_config_round_trips_to_disk() {
    let path = std::env::temp_dir().join(format!("screen-agent-{}.json", uuid::Uuid::new_v4()));
    let config = ProxyConfig {
        url: "http://127.0.0.1:9000".to_owned(),
        api_key: Some("proxy-secret".to_owned()),
        model: "chatgpt:chatgpt-web-session".to_owned(),
        chatgpt_mode: "web".to_owned(),
        chatgpt_think: false,
        session_id: Some("screen-agent".to_owned()),
        hotkey: "CommandOrControl+Shift+S".to_owned(),
        imglink_upload: true,
        imglink_api_key: Some("imglink-secret".to_owned()),
        image_upload_providers: default_image_upload_providers(),
        imgpile_api_token: None,
        postimages_api_token: None,
        imgbb_api_key: None,
        code_delivery: "notify".to_owned(),
    };
    save_config(&path, &config).await.expect("save config");
    assert_eq!(
        load_saved_config(&path).await.map(|value| value.url),
        Some(config.url)
    );
    let _ = tokio::fs::remove_file(path).await;
}

#[tokio::test]
async fn bridge_process_lock_is_released() {
    let runtime = std::env::temp_dir().join(format!("screen-agent-lock-{}", uuid::Uuid::new_v4()));
    tokio::fs::create_dir_all(&runtime)
        .await
        .expect("create runtime");
    {
        let _lock = acquire_bridge_process_lock(&runtime)
            .await
            .expect("acquire bridge lock");
        assert!(runtime.join("bridge-process.lock").exists());
    }
    assert!(!runtime.join("bridge-process.lock").exists());
    let _ = tokio::fs::remove_dir_all(runtime).await;
}
