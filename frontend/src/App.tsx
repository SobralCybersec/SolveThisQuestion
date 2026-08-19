import { FormEvent, useEffect, useMemo, useState } from "react";
import { ConfigPanel } from "./components/ConfigPanel";
import { Badge, Button, Card, GptIcon, Input, Label, Switch, Textarea } from "./components/ui";
import { API_BASE } from "./lib/api";

type RunState = "ready" | "capturing" | "answer" | "error";
type PageElement = { tag: string; role?: string; text?: string; href?: string; x: number; y: number; width: number; height: number };
type EventData = { run_id?: string; answer?: string; short_answer?: string; title?: string; url?: string; screenshot?: string; screenshot_size?: number; viewport?: { width: number; height: number; device_pixel_ratio: number }; elements?: PageElement[]; images?: { alt?: string; src?: string; width?: number; height?: number }[]; image_upload?: { status?: string; url?: string }; image_analyzed?: boolean; web_search?: boolean; error?: string };

const starterPrompt = "Read this page and answer the question in one crisp paragraph. Highlight the key action or decision.";

export default function App() {
  const [url, setUrl] = useState("https://example.com");
  const [prompt, setPrompt] = useState(starterPrompt);
  const [webSearch, setWebSearch] = useState(false);
  const [state, setState] = useState<RunState>("ready");
  const [answer, setAnswer] = useState("");
  const [capture, setCapture] = useState<EventData>({});
  const [error, setError] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    const source = new EventSource(`${API_BASE}/api/events`);
    const onCapture = (event: MessageEvent<string>) => {
      setCapture(JSON.parse(event.data));
      setState("capturing");
    };
    const onAnswer = (event: MessageEvent<string>) => {
      const data = JSON.parse(event.data) as EventData;
      setAnswer(data.answer || "");
      setState("answer");
    };
    const onError = (event: MessageEvent<string>) => {
      setError((JSON.parse(event.data) as EventData).error || "Run failed");
      setState("error");
    };
    source.addEventListener("capture.ready", onCapture);
    source.addEventListener("answer.ready", onAnswer);
    source.addEventListener("run.failed", onError);
    return () => source.close();
  }, []);

  const statusLabel = useMemo(() => ({ ready: "Ready", capturing: "Reading screen", answer: "Answer ready", error: "Needs attention" }[state]), [state]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setState("capturing"); setAnswer(""); setError("");
    try {
      const response = await fetch(`${API_BASE}/api/run`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ url, prompt, web_search: webSearch }),
      });
      if (!response.ok) { setState("error"); setError((await response.json()).error || "Could not queue run"); }
    } catch (reason) {
      setState("error");
      setError(reason instanceof Error ? reason.message : "Could not queue run");
    }
  }

  return <main className="shell">
    <section className="workspace">
      <header className="topbar"><div className="brand"><span className="mark"><GptIcon /></span><h1>Ask what matters.</h1></div><div className="topbar-actions"><button className="settings-trigger" type="button" onClick={() => setSettingsOpen(true)}>Config</button><Badge tone={state === "ready" ? "neutral" : "live"}>{statusLabel}</Badge></div></header>
      <div className="grid">
        <Card className="run-card">
          <div className="card-head"><h2>Capture</h2></div>
          <form onSubmit={submit}>
            <Label>Page URL<Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" /></Label>
            <Label>Question for the agent<Textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={5} /></Label>
            <div className="switch-row"><span>Search web for current context</span><Switch checked={webSearch} onCheckedChange={setWebSearch} /></div>
            <Button type="submit" disabled={state === "capturing"}><span>{state === "capturing" ? "Reading page…" : "Read screen"}</span><b>↗</b></Button>
          </form>
        </Card>
        <Card className="answer-card">
          <div className="card-head"><h2>Answer</h2></div>
          {state === "answer" ? <div className="answer-body">
            {capture.screenshot && <img className="capture-preview" src={`${API_BASE}${capture.screenshot}`} alt={`Screenshot of ${capture.title || "captured page"}`} />}
            <p>{answer}</p>
            <details className="element-inspector">
              <summary>{capture.elements?.length || 0} page elements extracted</summary>
              <ul>{(capture.elements || []).slice(0, 20).map((element, index) => <li key={`${element.tag}-${index}`}><code>{element.tag}</code><span>{element.text || element.href || "unnamed"}</span></li>)}</ul>
            </details>
            <div className="answer-meta"><span>{capture.image_analyzed ? "Image analyzed" : "Screenshot captured"}</span><span>{capture.image_upload?.status === "uploaded" ? "ImgLink uploaded" : "Local image"}</span><span>{capture.web_search ? "Web search" : "Local context"}</span><span>{capture.title || "Captured page"}</span></div>
          </div> : <div className="empty"><div className="empty-ring">✦</div><p>{state === "capturing" ? "Reading viewport and page text…" : state === "error" ? error : "Your answer will land here."}</p><span>{state === "error" ? "Check bridge, proxy, and target URL." : "Run agent to start a fresh capture."}</span></div>}
        </Card>
      </div>
      <ConfigPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </section>
  </main>;
}
