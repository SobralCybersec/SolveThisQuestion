import { useEffect, useRef, useState } from "react";

// Frameless always-on-top window that shows the code answer. The Rust side calls
// set_content_protected(true) so it's hidden from screen capture on Windows/macOS
// (no-op on Linux/Wayland). Tauri events arrive via the global bridge
// (withGlobalTauri), so no npm @tauri-apps/api dependency is needed.
type Payload = { code: string; language: string };

type TauriApi = {
  core?: { invoke: <T>(command: string) => Promise<T> };
  event?: { listen: (event: string, callback: (event: { payload: Payload }) => void) => Promise<() => void> };
};

export default function Overlay() {
  const [code, setCode] = useState("");
  const [language, setLanguage] = useState("");
  const codeRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    const element = codeRef.current;
    if (!element || !code) return;
    let direction = 1;
    let previousTime = performance.now();
    let holdUntil = previousTime + 1200;
    const scroll = () => {
      const now = performance.now();
      const maxScroll = Math.max(0, element.scrollHeight - element.clientHeight);
      const elapsed = Math.min(now - previousTime, 250);
      if (maxScroll > 2 && now >= holdUntil) {
        const nextTop = element.scrollTop + direction * elapsed * 0.03;
        if (nextTop >= maxScroll) {
          element.scrollTop = maxScroll;
          direction = -1;
          holdUntil = now + 1200;
        } else if (nextTop <= 0) {
          element.scrollTop = 0;
          direction = 1;
          holdUntil = now + 1200;
        } else {
          element.scrollTop = nextTop;
        }
      }
      previousTime = now;
    };
    scroll();
    const timer = window.setInterval(scroll, 33);
    return () => window.clearInterval(timer);
  }, [code]);

  useEffect(() => {
    const tauri = (window as unknown as { __TAURI__?: TauriApi }).__TAURI__;
    if (!tauri) return;
    let active = true;
    const apply = (payload: Payload | null | undefined) => {
      if (!active || !payload?.code) return;
      setCode(payload.code);
      setLanguage(payload.language ?? "");
    };

    let reading = false;
    const readPending = async () => {
      if (!tauri.core || reading) return;
      reading = true;
      try {
        apply(await tauri.core.invoke<Payload | null>("take_overlay_payload"));
      } catch {
        // Event delivery remains available when IPC is unavailable.
      } finally {
        reading = false;
      }
    };
    // Read on mount and keep checking for answers sent while listener setup or
    // an existing overlay window is still in progress.
    void readPending();
    const poll = window.setInterval(() => { void readPending(); }, 250);

    let unlisten: (() => void) | undefined;
    if (!tauri.event) return () => {
      active = false;
      window.clearInterval(poll);
    };
    void tauri.event.listen("overlay.code", (event) => {
      apply(event.payload);
    }).then((off) => {
      if (active) unlisten = off;
      else off();
    }).catch(() => {});
    return () => {
      active = false;
      window.clearInterval(poll);
      unlisten?.();
    };
  }, []);

  return <div className="overlay">
    <div className="overlay-bar">
      <span className="overlay-lang">{language || "code"}</span>
      <span className="overlay-hint">auto-scroll · always on top</span>
    </div>
    <pre ref={codeRef} className="overlay-code">{code || "Waiting for a coding answer…"}</pre>
  </div>;
}
