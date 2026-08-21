import { FormEvent, useEffect, useRef, useState } from "react";
import { API_BASE } from "./lib/api";
import { Button, Textarea } from "./components/ui";

type ChatRole = "user" | "assistant";
type ChatMessage = { id: string; role: ChatRole; content: string; reasoning?: string };
type ChatEvent = { message_id?: string; content?: string; reasoning_content?: string | null; error?: string };
type PendingChatEvent = { kind: "message" | "failed"; data: ChatEvent };
type MessageSetter = (value: ChatMessage[] | ((current: ChatMessage[]) => ChatMessage[])) => void;

export async function queueChat(prompt: string, history: Pick<ChatMessage, "role" | "content">[]) {
  const response = await fetch(`${API_BASE}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt, history }),
  });
  const payload = await response.json();
  const messageId = typeof payload.message_id === "string" ? payload.message_id : undefined;
  return {
    ok: response.ok && Boolean(messageId),
    messageId,
    error: payload.error || (response.ok && !messageId ? "Chat response did not include a message ID" : "Could not send message"),
  };
}

async function submitChat(prompt: string, history: Pick<ChatMessage, "role" | "content">[]) {
  try {
    return await queueChat(prompt, history);
  } catch (reason) {
    return { ok: false, messageId: undefined, error: reason instanceof Error ? reason.message : "Could not send message" };
  }
}

type ComposerContext = {
  event?: FormEvent;
  draft: string;
  thinking: boolean;
  messages: ChatMessage[];
  setMessages: (value: ChatMessage[] | ((current: ChatMessage[]) => ChatMessage[])) => void;
  setDraft: (value: string) => void;
  setThinking: (value: boolean) => void;
  setError: (value: string) => void;
  setActiveMessageId: (value: string | null) => void;
  eventsReady: boolean;
};

async function sendChatMessage(context: ComposerContext) {
  context.event?.preventDefault();
  const prompt = context.draft.trim();
  if (!prompt || context.thinking || !context.eventsReady) return;
  const history = context.messages.map(({ role, content }) => ({ role, content }));
  context.setMessages((current) => [...current, { id: crypto.randomUUID(), role: "user", content: prompt }]);
  context.setDraft("");
  context.setThinking(true);
  context.setError("");
  const result = await submitChat(prompt, history);
  if (!result.ok) {
    context.setActiveMessageId(null);
    context.setThinking(false);
    context.setError(result.error);
  } else {
    context.setActiveMessageId(result.messageId || null);
  }
}

function parseChatEvent(event: MessageEvent<string>) {
  try { return JSON.parse(event.data) as ChatEvent; } catch { return null; }
}

type MessageFinishContext = {
  data: ChatEvent;
  activeMessageIdRef: React.MutableRefObject<string | null>;
  completedMessageIdsRef: React.MutableRefObject<Set<string>>;
  setMessages: MessageSetter;
  setThinking: (value: boolean) => void;
};

function finishMessage(context: MessageFinishContext) {
  const messageId = context.data.message_id;
  if (!messageId || messageId !== context.activeMessageIdRef.current || context.completedMessageIdsRef.current.has(messageId)) return;
  context.completedMessageIdsRef.current.add(messageId);
  context.activeMessageIdRef.current = null;
  context.setMessages((current) => [...current, {
    id: messageId,
    role: "assistant",
    content: context.data.content || "",
    ...(context.data.reasoning_content ? { reasoning: context.data.reasoning_content } : {}),
  }]);
  context.setThinking(false);
}

function finishFailure(data: ChatEvent, activeMessageIdRef: React.MutableRefObject<string | null>, setThinking: (value: boolean) => void, setError: (value: string) => void) {
  if (!data.message_id || data.message_id !== activeMessageIdRef.current) return;
  activeMessageIdRef.current = null;
  setThinking(false);
  setError(data.error || "Chat request failed");
}

type CompletedChatContext = {
  kind: PendingChatEvent["kind"];
  event: MessageEvent<string>;
  activeMessageIdRef: React.MutableRefObject<string | null>;
  pendingEventsRef: React.MutableRefObject<Map<string, PendingChatEvent>>;
  finish: (data: ChatEvent) => void;
};

function handleCompletedChatEvent(context: CompletedChatContext) {
  const data = parseChatEvent(context.event);
  if (!data?.message_id) return;
  if (!context.activeMessageIdRef.current) {
    context.pendingEventsRef.current.set(data.message_id, { kind: context.kind, data });
    return;
  }
  context.finish(data);
}

function useChatEvents(setMessages: MessageSetter, setThinking: (value: boolean) => void, setError: (value: string) => void) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const activeMessageIdRef = useRef<string | null>(null);
  const completedMessageIdsRef = useRef(new Set<string>());
  const pendingEventsRef = useRef(new Map<string, PendingChatEvent>());
  const eventsReadyRef = useRef(false);
  const [eventsReady, setEventsReady] = useState(false);

  useEffect(() => {
    inputRef.current?.focus();
    const source = new EventSource(`${API_BASE}/api/events`);
    const setReady = (value: boolean) => {
      eventsReadyRef.current = value;
      setEventsReady(value);
    };
    source.onopen = () => setReady(true);
    source.onerror = () => {
      setReady(false);
      if (!activeMessageIdRef.current) return;
      activeMessageIdRef.current = null;
      pendingEventsRef.current.clear();
      setThinking(false);
      setError("Chat event stream disconnected; retry message.");
    };
    const onThinking = (event: MessageEvent<string>) => {
      const data = parseChatEvent(event);
      if (data?.message_id !== activeMessageIdRef.current) return;
      setThinking(true);
      setError("");
    };
    const onMessage = (event: MessageEvent<string>) => handleCompletedChatEvent({ kind: "message", event, activeMessageIdRef, pendingEventsRef, finish: (data) => finishMessage({ data, activeMessageIdRef, completedMessageIdsRef, setMessages, setThinking }) });
    const onFailure = (event: MessageEvent<string>) => handleCompletedChatEvent({ kind: "failed", event, activeMessageIdRef, pendingEventsRef, finish: (data) => finishFailure(data, activeMessageIdRef, setThinking, setError) });
    source.addEventListener("chat.thinking", onThinking);
    source.addEventListener("chat.message", onMessage);
    source.addEventListener("chat.failed", onFailure);
    return () => {
      setReady(false);
      source.close();
    };
  }, []);

  const setActiveMessageId = (value: string | null) => {
    activeMessageIdRef.current = value;
    if (!value) return;
    if (!eventsReadyRef.current) {
      activeMessageIdRef.current = null;
      setThinking(false);
      setError("Chat event stream disconnected; retry message.");
      return;
    }
    const pending = pendingEventsRef.current.get(value);
    if (!pending) return;
    pendingEventsRef.current.delete(value);
    if (pending.kind === "message") finishMessage({ data: pending.data, activeMessageIdRef, completedMessageIdsRef, setMessages, setThinking });
    else finishFailure(pending.data, activeMessageIdRef, setThinking, setError);
  };

  return { inputRef, setActiveMessageId, eventsReady };
}

function ChatMessages({ messages, thinking, error, messagesRef }: { messages: ChatMessage[]; thinking: boolean; error: string; messagesRef: React.MutableRefObject<HTMLDivElement | null> }) {
  return <div className="chat-messages" ref={messagesRef}>
    {messages.length === 0 && <div className="chat-empty"><span className="empty-ring">✦</span><p>Ask anything.</p><span>Chat stays in this overlay. Scroll through replies as conversation grows.</span></div>}
    {messages.map((message) => <article className={`chat-message chat-${message.role}`} key={message.id}>
      <span className="chat-role">{message.role === "user" ? "YOU" : "AGENT"}</span>
      <p>{message.content}</p>
      {message.reasoning && <details className="chat-thinking"><summary>Agent thinking</summary><p>{message.reasoning}</p></details>}
    </article>)}
    {thinking && <article className="chat-message chat-assistant chat-pending"><span className="chat-role">AGENT</span><p>Thinking<span className="thinking-dots">…</span></p></article>}
    {error && <p className="chat-error">{error}</p>}
  </div>;
}

export default function ChatOverlay() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [thinking, setThinking] = useState(false);
  const [error, setError] = useState("");
  const messagesRef = useRef<HTMLDivElement>(null);
  const { inputRef, setActiveMessageId, eventsReady } = useChatEvents(setMessages, setThinking, setError);

  useEffect(() => {
    const element = messagesRef.current;
    if (element) element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
  }, [messages, thinking, error]);

  const send = (event?: FormEvent) => void sendChatMessage({ event, draft, thinking, messages, setMessages, setDraft, setThinking, setError, setActiveMessageId, eventsReady });

  async function close() {
    await fetch(`${API_BASE}/api/chat/toggle`, { method: "POST" }).catch(() => {});
  }

  return <main className="chat-overlay">
    <header className="chat-bar">
      <div><span className="overlay-lang">AGENT CHAT</span><span className="chat-subtitle">normal conversation</span></div>
      <button className="chat-close" type="button" onClick={close} aria-label="Close chat">×</button>
    </header>
    <ChatMessages messages={messages} thinking={thinking} error={error} messagesRef={messagesRef} />
    <form className="chat-composer" onSubmit={send}>
      <div className="chat-composer-control">
        <Textarea
          ref={inputRef}
          className="chat-composer-input"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); } }}
          placeholder="Message agent…"
          rows={3}
          aria-label="Message agent"
        />
        <Button className="chat-send" type="submit" disabled={!draft.trim() || thinking || !eventsReady}>Send <span>↗</span></Button>
      </div>
    </form>
  </main>;
}
