import { FormEvent, useEffect, useState } from "react";
import { Button, Input, Select } from "./ui";
import { API_BASE } from "../lib/api";

type Config = {
  url: string;
  model: string;
  chatgpt_mode: "auto" | "web";
  chatgpt_think: boolean;
  session_id: string;
  hotkey: string;
  imglink_upload: boolean;
  imglink_api_key_configured: boolean;
  api_key_configured: boolean;
  mode?: "embedded" | "external";
};

type Health = { bridge: boolean; proxy_configured: boolean; proxy_model?: string; proxy_mode?: "embedded" | "external" };
type ProxyStatus = { logged_in?: boolean; ready?: boolean; login_in_progress?: boolean; mode?: "embedded" | "external" };

type Props = { open: boolean; onClose: () => void };

const fallback: Config = {
  url: "",
  model: "chatgpt:chatgpt-web-session",
  chatgpt_mode: "web",
  chatgpt_think: false,
  session_id: "screen-agent",
  hotkey: "CommandOrControl+Shift+S",
  imglink_upload: false,
  imglink_api_key_configured: false,
  api_key_configured: false,
  mode: "embedded",
};

export function ConfigPanel({ open, onClose }: Props) {
  const [config, setConfig] = useState<Config>(fallback);
  const [apiKey, setApiKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [imglinkKey, setImgLinkKey] = useState("");
  const [clearImgLinkKey, setClearImgLinkKey] = useState(false);
  const [health, setHealth] = useState<Health | null>(null);
  const [loginReady, setLoginReady] = useState(false);
  const [loginInProgress, setLoginInProgress] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setMessage("");
    setError("");
    void Promise.all([fetch(`${API_BASE}/api/config`), fetch(`${API_BASE}/api/health`), fetch(`${API_BASE}/api/proxy/status`),])
      .then(async ([configResponse, healthResponse, statusResponse]) => {
        if (!configResponse.ok) throw new Error("Could not load proxy config");
        const next = (await configResponse.json()) as Config;
        setConfig({ ...fallback, ...next });
        setHealth(healthResponse.ok ? ((await healthResponse.json()) as Health) : null);
        const status = statusResponse.ok ? ((await statusResponse.json()) as ProxyStatus) : null;
        setLoginReady(Boolean(status?.logged_in || status?.ready));
        setLoginInProgress(Boolean(status?.login_in_progress));
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Could not load config"));
  }, [open]);

  useEffect(() => {
    if (!open || config.url || !loginInProgress) return;
    const timer = window.setInterval(() => {
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 9000);
      void fetch(`${API_BASE}/api/proxy/status`, { signal: controller.signal })
        .then(async (response) => response.ok ? (await response.json()) as ProxyStatus : null)
        .then((status) => {
          if (!status) return;
          const ready = Boolean(status.logged_in || status.ready);
          setLoginReady(ready);
          setLoginInProgress(Boolean(status.login_in_progress));
          if (ready) setMessage("ChatGPT linked. Run the agent.");
        })
        .catch(() => {})
        .finally(() => window.clearTimeout(timeout));
    }, 1500);
    return () => window.clearInterval(timer);
  }, [config.url, loginInProgress, open]);

  function update<K extends keyof Config>(key: K, value: Config[K]) {
    setConfig((current) => ({ ...current, [key]: value }));
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setMessage(""); setError("");
    try {
      const response = await fetch(`${API_BASE}/api/config`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url: config.url,
          model: config.model,
          chatgpt_mode: config.chatgpt_mode,
          chatgpt_think: config.chatgpt_think,
          session_id: config.session_id,
          hotkey: config.hotkey,
          imglink_upload: config.imglink_upload,
          ...(imglinkKey ? { imglink_api_key: imglinkKey } : {}),
          ...(clearImgLinkKey ? { clear_imglink_api_key: true } : {}),
          ...(apiKey ? { api_key: apiKey } : {}),
          ...(clearKey ? { clear_api_key: true } : {}),
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Could not save proxy config");
      setConfig((current) => ({ ...current, ...payload }));
      setApiKey(""); setClearKey(false); setMessage("Saved to app config.");
      setImgLinkKey(""); setClearImgLinkKey(false);
      setHealth((current) => current ? { ...current, proxy_configured: Boolean(payload.url), proxy_mode: payload.mode } : current);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not save proxy config");
    } finally {
      setBusy(false);
    }
  }

  async function login() {
    setBusy(true); setMessage(""); setError("");
    setLoginInProgress(true);
    setMessage("Opening ChatGPT login window…");
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 60000);
    try {
      const response = await fetch(`${API_BASE}/api/proxy/login`, { method: "POST", signal: controller.signal });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Could not open ChatGPT login");
      const ready = Boolean(payload.logged_in || payload.ready);
      setLoginReady(ready);
      setLoginInProgress(Boolean(payload.login_in_progress));
      setMessage(ready ? "ChatGPT linked. Run the agent." : "ChatGPT login window opened. Finish login, then run agent.");
    } catch (reason) {
      setLoginInProgress(false);
      setMessage("");
      setError(reason instanceof DOMException && reason.name === "AbortError" ? "ChatGPT login window did not open. Check browser/runtime settings." : reason instanceof Error ? reason.message : "Could not open ChatGPT login");
    } finally {
      window.clearTimeout(timeout);
      setBusy(false);
    }
  }

  async function closeLogin() {
    setBusy(true); setMessage(""); setError("");
    try {
      const response = await fetch(`${API_BASE}/api/proxy/close-login`, { method: "POST" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Could not close ChatGPT login");
      setLoginInProgress(false);
      setMessage("ChatGPT login window closed.");
    } catch (reason) {
      setLoginInProgress(false);
      setError(reason instanceof Error ? reason.message : "Could not close ChatGPT login");
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;

  return <div className="settings-backdrop" role="presentation" onMouseDown={onClose}>
    <aside className="settings-panel" role="dialog" aria-modal="true" aria-labelledby="settings-title" onMouseDown={(event) => event.stopPropagation()}>
      <div className="settings-head"><div><span className="eyebrow">CONTROL ROOM</span><h2 id="settings-title">Proxy config</h2></div><button className="close-button" type="button" onClick={onClose} aria-label="Close settings">×</button></div>
      <p className="settings-intro">Blank Hub URL uses embedded RustProxyHub. Browser cookies and ChatGPT session state stay inside this app.</p>
      <div className="settings-health">
        <span><i className={health?.bridge ? "health-dot is-on" : "health-dot"} /> bridge {health?.bridge ? "ready" : "offline"}</span>
        <span><i className={health?.proxy_mode === "embedded" || health?.proxy_configured ? "health-dot is-on" : "health-dot"} /> {health?.proxy_mode === "embedded" ? "embedded bridge" : "external proxy"}</span>
        {!config.url && <span><i className={loginReady ? "health-dot is-on" : "health-dot"} /> {loginReady ? "ChatGPT linked" : "login required"}</span>}
      </div>
      <form onSubmit={save}>
        <label>External Hub URL<Input value={config.url} onChange={(event) => update("url", event.target.value)} placeholder="Blank = embedded bridge" /></label>
        <label>API key<Input type="password" value={apiKey} onChange={(event) => { setApiKey(event.target.value); setClearKey(false); }} placeholder={config.api_key_configured ? "Saved key · enter to replace" : "Optional for loopback Hub"} autoComplete="off" /></label>
        {config.api_key_configured && <button className="link-button" type="button" onClick={() => { setClearKey(true); setApiKey(""); }}>Clear saved key</button>}
        <label>Model<Input value={config.model} onChange={(event) => update("model", event.target.value)} placeholder="chatgpt:chatgpt-web-session" /></label>
        <div className="settings-row">
          <label>ChatGPT mode<Select value={config.chatgpt_mode} onChange={(event) => update("chatgpt_mode", event.target.value as Config["chatgpt_mode"])}><option value="web">web session</option><option value="auto">auto</option></Select></label>
          <label>Session ID<Input value={config.session_id} onChange={(event) => update("session_id", event.target.value)} placeholder="screen-agent" /></label>
        </div>
        <label className="check-row"><input type="checkbox" checked={config.chatgpt_think} onChange={(event) => update("chatgpt_think", event.target.checked)} /><span>Think mode — deeper reasoning on desktop captures (slower)</span></label>
        <label>Desktop screenshot keybind<Input value={config.hotkey} onChange={(event) => update("hotkey", event.target.value)} placeholder="CommandOrControl+Shift+S" /></label>
        <label className="check-row"><input type="checkbox" checked={config.imglink_upload} onChange={(event) => update("imglink_upload", event.target.checked)} /><span>Upload screenshots to ImgLink</span></label>
        <label>ImgLink API key<Input type="password" value={imglinkKey} onChange={(event) => { setImgLinkKey(event.target.value); setClearImgLinkKey(false); }} placeholder={config.imglink_api_key_configured ? "Saved key · enter to replace" : "Required when upload is enabled"} autoComplete="off" /></label>
        {config.imglink_api_key_configured && <button className="link-button" type="button" onClick={() => { setClearImgLinkKey(true); setImgLinkKey(""); }}>Clear ImgLink key</button>}
        <Button type="submit" disabled={busy}>{busy ? "Saving…" : "Save proxy config"}<b>↗</b></Button>
      </form>
      {!config.url && <Button type="button" disabled={busy || loginInProgress} onClick={login}>{loginInProgress ? "Waiting for ChatGPT login…" : "Open embedded ChatGPT login"} <b>↗</b></Button>}
      {!config.url && loginInProgress && <Button type="button" disabled={busy} onClick={closeLogin}>Close ChatGPT login <b>×</b></Button>}
      {message && <p className="settings-message is-success">{message}</p>}
      {error && <p className="settings-message is-error">{error}</p>}
      <p className="settings-footnote">Keybind captures primary monitor after user trigger, sends screenshot through current proxy, then posts notification. Runtime changes apply to next run.</p>
    </aside>
  </div>;
}
