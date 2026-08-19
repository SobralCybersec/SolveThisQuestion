# Screen Agent

Small local agent: Playwright captures a target page, sends screenshot + visible text to an OpenAI-compatible GPT proxy, streams lifecycle events over SSE, and posts a desktop notification on Linux or Windows.

## Run

```bash
npm --prefix bridge install
cargo run
npm --prefix frontend install
npm --prefix frontend run dev
```

Open `http://localhost:5173`. Preferred wiring uses `RUST_PROXY_HUB_URL` plus `RUST_PROXY_HUB_API_KEY`. The bridge calls `${RUST_PROXY_HUB_URL}/v1/chat/completions` with `Authorization: Bearer`, `x-api-key`, `model: chatgpt:chatgpt-web-session`, `chatgpt_mode: web`, and an optional stable `user` session id. `GPT_PROXY_*` remains a generic OpenAI-compatible fallback.

## Shape

- Rust/Axum: `POST /api/run`, `GET /api/events`, `GET /api/health`
- Playwright bridge: `bridge/index.mjs`, JSONL stdin/stdout
- Notifications: `notify-rust` platform adapter
- UI: React + shadcn/ui-compatible primitives, deliberately small and dependency-light

## Proxy flow

RustProxyHub owns the authenticated, persistent ChatGPT Playwright profile. Its bridge captures live request headers and payload, replays `/backend-api/f/conversation`, retries after 401/403, polls the conversation result, and stores `conversation_id` plus `parent_message_id` per session. Screen Agent only captures the target page and sends multimodal OpenAI-shaped input to the Hub, so browser cookies and sentinel headers stay inside RustProxyHub.

## Verify

```bash
cargo test
cargo run
curl http://127.0.0.1:8787/api/health
```

Without `GPT_PROXY_URL`, runs still capture a page and return a local summary. This makes bridge/UI smoke tests work before proxy wiring.
