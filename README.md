# Screen Agent

Small local agent: Playwright captures a target page, sends screenshot + visible text to an OpenAI-compatible GPT proxy, streams lifecycle events over SSE, and posts a desktop notification on Linux or Windows.

## Run

```bash
pnpm install
pnpm bridge:install
pnpm desktop:dev
```

`pnpm desktop:dev` starts Vite on `http://localhost:5173` and Tauri starts the API on `http://127.0.0.1:8787`. Blank Hub URL uses the embedded RustProxyHub bridge. Open `CONFIG`, click `Open embedded ChatGPT login`, finish sign-in, then run the agent. The persistent profile and storage state live under the app runtime directory. An external `RUST_PROXY_HUB_URL` plus `RUST_PROXY_HUB_API_KEY` remains supported.

## Shape

- Rust/Axum: `POST /api/run`, `GET /api/events`, `GET /api/health`
- Session: `POST /api/proxy/login`, `GET /api/proxy/status`
- Runtime config: `GET /api/config`, `PUT /api/config` (secret is write-only)
- Playwright bridge: `bridge/index.mjs`, JSONL stdin/stdout
- Notifications: `notify-rust` platform adapter
- UI: React + shadcn/ui-compatible primitives, deliberately small and dependency-light

## Proxy flow

The embedded bridge owns the authenticated, persistent ChatGPT Playwright profile. Login waits for a real `session-token` cookie, saves Playwright `storageState`, and restores it on the next run. Text requests use the captured web-session payload; screenshot requests upload the saved browser capture through the logged-in ChatGPT page. `web_search` maps to RustProxyHub's `selected_sources: ["web"]` and `force_use_tool: "web"` payload fields. Conversation state stores `conversation_id` plus `parent_message_id` per session.

Headless defaults match both reference bridges: target capture, normal ChatGPT, and image analysis use headless Chromium. Login stays visible. Set `SCREEN_AGENT_BROWSER_HEADLESS=false` or `SCREEN_AGENT_CHATGPT_HEADLESS=false` to inspect a browser window. `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` overrides browser discovery; otherwise the bridge prefers installed Chromium-family binaries before Playwright's bundled browser.

Each run returns viewport dimensions, visible page elements, image inventory, screenshot byte size, and a served preview at `/captures/<run_id>.png`. Optional ImgLink sharing is explicit: set `SCREEN_AGENT_IMGLINK_UPLOAD=true` and `SCREEN_AGENT_IMGLINK_API_KEY`. The bridge uploads server-side with `POST https://imglink.cc/api/upload`; default remains local-only. ImgLink API docs specify `file` multipart field and direct `images[].url` response.

Desktop capture: configure `CommandOrControl+Shift+S` in CONFIG. On Hyprland/Wayland, the app registers a compositor Lua bind through `hyprctl eval hl.bind(...)`; the bind calls local `POST /api/capture`, avoiding Tauri global-shortcut's Wayland callback gap. Other platforms use Tauri global-shortcut. Native XCap captures the primary monitor, sends it through the current AI bridge, then emits SSE and desktop notification. Linux falls back to `grim` when XCap cannot enumerate the compositor. This captures pixels outside browser page scripts; it is user-triggered and does not hide capture activity from the app user. Set `SCREEN_AGENT_HOTKEY=` to disable startup registration. `SCREEN_AGENT_SCREEN_PROMPT` changes the default desktop prompt. CONFIG can enable ImgLink and store its key for the running app.

## Verify

```bash
cargo test
pnpm desktop:dev
curl http://127.0.0.1:8787/api/health
```

Without an external proxy URL, login is required before runs. This prevents silent local-summary responses and keeps the web-session path explicit.

## Quality

```bash
pnpm quality:install
pnpm quality
```

`quality:install` installs pinned `jscpd` and Lizard dependencies, ESLint, the Rust Clippy component, and `cargo-machete`. Reports are written to `reports/quality/`. `quality` runs tests, line coverage, Clippy, ESLint, cargo-machete, benchmarks, jscpd, file-size checks, and Lizard over `src`, `bridge/rustproxyhub`, and `frontend/src`.

Quality policy: files `<=400` lines are good, `401-800` need review, and `>800` fail; functions use NLOC `<=50` / `51-80` / `>80`, CCN `<=10` / `11-15` / `>15`, parameters `<=4` / `5-6` / `>6`, and nesting `<=3` / `>3`; duplication is good `<=3%`, warning `>3-5%`, and fail `>5%`. Final report includes `BAD (FAIL)`, `MUST FIX (WARNING)`, and `GOOD` columns plus separate Rust, bridge, and frontend areas.

Default gate blocks `BAD(FAIL)` only and prints `MUST FIX(WARNING)` as advisories; pass `--strict` to make warnings blocking.
