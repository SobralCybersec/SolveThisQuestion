import { FormEvent, useEffect, useMemo, useState } from "react";
import { ConfigPanel } from "./components/ConfigPanel";
import { Badge, Button, Card, GptIcon, Input, Label, Switch, Textarea } from "./components/ui";
import { API_BASE } from "./lib/api";

type RunState = "ready" | "capturing" | "answer" | "error";
type PageElement = { tag: string; role?: string; text?: string; href?: string; x: number; y: number; width: number; height: number };
type EventData = { run_id?: string; answer?: string; short_answer?: string; title?: string; url?: string; screenshot?: string; screenshot_size?: number; viewport?: { width: number; height: number; device_pixel_ratio: number }; elements?: PageElement[]; images?: { alt?: string; src?: string; width?: number; height?: number }[]; image_upload?: { status?: string; url?: string }; image_analyzed?: boolean; web_search?: boolean; error?: string };

const starterPrompt = "Read this page and answer the question in one crisp paragraph. Highlight the key action or decision.";

function useAgentEvents({ setCapture, setAnswer, setState, setError }: {
  setCapture: (value: EventData) => void;
  setAnswer: (value: string) => void;
  setState: (value: RunState) => void;
  setError: (value: string) => void;
}) {
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
  }, [setAnswer, setCapture, setError, setState]);
}

async function queueRun({ url, prompt, webSearch }: { url: string; prompt: string; webSearch: boolean }) {
  const response = await fetch(`${API_BASE}/api/run`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ url, prompt, web_search: webSearch }),
  });
  const payload = await response.json();
  return { ok: response.ok, error: payload.error || "Could not queue run" };
}

function statusLabelFor(state: RunState) {
  return { ready: "Ready", capturing: "Reading screen", answer: "Answer ready", error: "Needs attention" }[state];
}

async function submitRun(event: FormEvent, context: {
  url: string;
  prompt: string;
  webSearch: boolean;
  setState: (value: RunState) => void;
  setAnswer: (value: string) => void;
  setError: (value: string) => void;
}) {
  event.preventDefault();
  context.setState("capturing"); context.setAnswer(""); context.setError("");
  try {
    const result = await queueRun(context);
    if (!result.ok) { context.setState("error"); context.setError(result.error); }
  } catch (reason) {
    context.setState("error");
    context.setError(reason instanceof Error ? reason.message : "Could not queue run");
  }
}

type RunCardProps = {
  url: string;
  prompt: string;
  webSearch: boolean;
  state: RunState;
  setUrl: (value: string) => void;
  setPrompt: (value: string) => void;
  setWebSearch: (value: boolean) => void;
  onSubmit: (event: FormEvent) => void;
};

function RunCard(props: RunCardProps) {
  return <Card className="run-card">
    <div className="card-head"><h2>Capture</h2></div>
    <form onSubmit={props.onSubmit}>
      <Label>Page URL<Input value={props.url} onChange={(event) => props.setUrl(event.target.value)} placeholder="https://…" /></Label>
      <Label>Question for the agent<Textarea value={props.prompt} onChange={(event) => props.setPrompt(event.target.value)} rows={5} /></Label>
      <div className="switch-row"><span>Search web for current context</span><Switch checked={props.webSearch} onCheckedChange={props.setWebSearch} /></div>
      <Button type="submit" disabled={props.state === "capturing"}><span>{props.state === "capturing" ? "Reading page…" : "Read screen"}</span><b>↗</b></Button>
    </form>
  </Card>;
}

function AnswerDetails({ elements }: { elements?: PageElement[] }) {
  const items = (elements || []).slice(0, 20)
  return <details className="element-inspector">
    <summary>{elements?.length || 0} page elements extracted</summary>
    <ul>{items.map((element, index) => <li key={`${element.tag}-${index}`}><code>{element.tag}</code><span>{element.text || element.href || "unnamed"}</span></li>)}</ul>
  </details>
}

function AnswerMeta({ capture }: { capture: EventData }) {
  return <div className="answer-meta">
    <span>{capture.image_analyzed ? "Image analyzed" : "Screenshot captured"}</span>
    <span>{capture.image_upload?.status === "uploaded" ? "ImgLink uploaded" : "Local image"}</span>
    <span>{capture.web_search ? "Web search" : "Local context"}</span>
    <span>{capture.title || "Captured page"}</span>
  </div>
}

function AnswerContent({ answer, capture }: { answer: string; capture: EventData }) {
  return <div className="answer-body">
    {capture.screenshot && <img className="capture-preview" src={`${API_BASE}${capture.screenshot}`} alt={`Screenshot of ${capture.title || "captured page"}`} />}
    <p>{answer}</p>
    <AnswerDetails elements={capture.elements} />
    <AnswerMeta capture={capture} />
  </div>
}

function AnswerEmpty({ state, error }: { state: RunState; error: string }) {
  const message = state === "capturing" ? "Reading viewport and page text…" : state === "error" ? error : "Your answer will land here."
  const detail = state === "error" ? "Check bridge, proxy, and target URL." : "Run agent to start a fresh capture."
  return <div className="empty"><div className="empty-ring">✦</div><p>{message}</p><span>{detail}</span></div>
}

function AnswerCard({ state, answer, capture, error }: { state: RunState; answer: string; capture: EventData; error: string }) {
  return <Card className="answer-card">
    <div className="card-head"><h2>Answer</h2></div>
    {state === "answer" ? <AnswerContent answer={answer} capture={capture} /> : <AnswerEmpty state={state} error={error} />}
  </Card>;
}

export default function App() {
  const [url, setUrl] = useState("https://example.com");
  const [prompt, setPrompt] = useState(starterPrompt);
  const [webSearch, setWebSearch] = useState(false);
  const [state, setState] = useState<RunState>("ready");
  const [answer, setAnswer] = useState("");
  const [capture, setCapture] = useState<EventData>({});
  const [error, setError] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);

  useAgentEvents({ setCapture, setAnswer, setState, setError });

  const statusLabel = useMemo(() => statusLabelFor(state), [state]);
  const submit = (event: FormEvent) => submitRun(event, { url, prompt, webSearch, setState, setAnswer, setError });

  return <main className="shell">
    <section className="workspace">
      <header className="topbar"><div className="brand"><span className="mark"><GptIcon /></span><h1>Ask what matters.</h1></div><div className="topbar-actions"><button className="settings-trigger" type="button" onClick={() => setSettingsOpen(true)}>Config</button><Badge tone={state === "ready" ? "neutral" : "live"}>{statusLabel}</Badge></div></header>
      <div className="grid">
        <RunCard url={url} prompt={prompt} webSearch={webSearch} state={state} setUrl={setUrl} setPrompt={setPrompt} setWebSearch={setWebSearch} onSubmit={submit} />
        <AnswerCard state={state} answer={answer} capture={capture} error={error} />
      </div>
      <ConfigPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </section>
  </main>;
}
