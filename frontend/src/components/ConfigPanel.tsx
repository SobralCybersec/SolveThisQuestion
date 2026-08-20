import { FormEvent, useEffect, useState } from "react";
import { Button, Input, Label, Select, Switch } from "./ui";
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
  code_delivery: "notify" | "overlay" | "type";
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
  code_delivery: "notify",
  mode: "embedded",
};

type SaveContext = {
  config: Config;
  apiKey: string;
  clearKey: boolean;
  imglinkKey: string;
  clearImgLinkKey: boolean;
  setBusy: (value: boolean) => void;
  setMessage: (value: string) => void;
  setError: (value: string) => void;
  setConfig: (value: Config | ((current: Config) => Config)) => void;
  setApiKey: (value: string) => void;
  setClearKey: (value: boolean) => void;
  setImgLinkKey: (value: string) => void;
  setClearImgLinkKey: (value: boolean) => void;
  setHealth: (value: Health | ((current: Health | null) => Health | null)) => void;
};

function buildConfigPayload(config: Config, secrets: { apiKey: string; clearKey: boolean; imglinkKey: string; clearImgLinkKey: boolean }) {
  return {
    url: config.url,
    model: config.model,
    chatgpt_mode: config.chatgpt_mode,
    chatgpt_think: config.chatgpt_think,
    session_id: config.session_id,
    hotkey: config.hotkey,
    imglink_upload: config.imglink_upload,
    code_delivery: config.code_delivery,
    ...(secrets.imglinkKey ? { imglink_api_key: secrets.imglinkKey } : {}),
    ...(secrets.clearImgLinkKey ? { clear_imglink_api_key: true } : {}),
    ...(secrets.apiKey ? { api_key: secrets.apiKey } : {}),
    ...(secrets.clearKey ? { clear_api_key: true } : {}),
  };
}

async function saveProxyConfig(config: Config, secrets: { apiKey: string; clearKey: boolean; imglinkKey: string; clearImgLinkKey: boolean }) {
  const response = await fetch(`${API_BASE}/api/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(buildConfigPayload(config, secrets)),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Could not save proxy config");
  return payload as Partial<Config>;
}

async function submitConfig(event: FormEvent, context: SaveContext) {
  event.preventDefault();
  context.setBusy(true); context.setMessage(""); context.setError("");
  try {
    const payload = await saveProxyConfig(context.config, context);
    context.setConfig((current) => ({ ...current, ...payload }));
    context.setApiKey(""); context.setClearKey(false); context.setMessage("Saved to app config.");
    context.setImgLinkKey(""); context.setClearImgLinkKey(false);
    context.setHealth((current) => current ? { ...current, proxy_configured: Boolean(payload.url), proxy_mode: payload.mode } : current);
  } catch (reason) {
    context.setError(reason instanceof Error ? reason.message : "Could not save proxy config");
  } finally {
    context.setBusy(false);
  }
}

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

  const save = (event: FormEvent) => submitConfig(event, {
    config, apiKey, clearKey, imglinkKey, clearImgLinkKey,
    setBusy, setMessage, setError, setConfig, setApiKey, setClearKey,
    setImgLinkKey, setClearImgLinkKey, setHealth,
  });

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
        <Label>External Hub URL<Input value={config.url} onChange={(event) => update("url", event.target.value)} placeholder="Blank = embedded bridge" /></Label>
        <Label>API key<Input type="password" value={apiKey} onChange={(event) => { setApiKey(event.target.value); setClearKey(false); }} placeholder={config.api_key_configured ? "Saved key · enter to replace" : "Optional for loopback Hub"} autoComplete="off" /></Label>
        {config.api_key_configured && <button className="link-button" type="button" onClick={() => { setClearKey(true); setApiKey(""); }}>Clear saved key</button>}
        <Label>Model<Input value={config.model} onChange={(event) => update("model", event.target.value)} placeholder="chatgpt:chatgpt-web-session" /></Label>
        <div className="settings-row">
          <Label>ChatGPT mode<Select value={config.chatgpt_mode} onValueChange={(value) => update("chatgpt_mode", value as Config["chatgpt_mode"])} options={[{ value: "web", label: "web session" }, { value: "auto", label: "auto" }]} /></Label>
          <Label>Session ID<Input value={config.session_id} onChange={(event) => update("session_id", event.target.value)} placeholder="screen-agent" /></Label>
        </div>
        <div className="switch-row"><span>Think mode — deeper reasoning on desktop captures (slower)</span><Switch checked={config.chatgpt_think} onCheckedChange={(value) => update("chatgpt_think", value)} /></div>
        <Label>Coding answer delivery<Select value={config.code_delivery} onValueChange={(value) => update("code_delivery", value as Config["code_delivery"])} options={[{ value: "notify", label: "notification" }, { value: "type", label: "auto-type into editor" }, { value: "overlay", label: "overlay window" }]} /></Label>
        <Label>Desktop screenshot keybind<Input value={config.hotkey} onChange={(event) => update("hotkey", event.target.value)} placeholder="CommandOrControl+Shift+S" /></Label>
        <div className="switch-row"><span>Upload screenshots to ImgLink</span><Switch checked={config.imglink_upload} onCheckedChange={(value) => update("imglink_upload", value)} /></div>
        <Label>ImgLink API key<Input type="password" value={imglinkKey} onChange={(event) => { setImgLinkKey(event.target.value); setClearImgLinkKey(false); }} placeholder={config.imglink_api_key_configured ? "Saved key · enter to replace" : "Required when upload is enabled"} autoComplete="off" /></Label>
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
