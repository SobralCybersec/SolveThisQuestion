import { useState } from "react";
import type { DragEvent, KeyboardEvent } from "react";

type HotkeyProps = { value: string; placeholder: string; onChange: (value: string) => void };
type PendingHotkey = { modifiers: string[]; key: string };

const modifierForCode: Record<string, string> = {
  ControlLeft: "CommandOrControl",
  ControlRight: "CommandOrControl",
  MetaLeft: "CommandOrControl",
  MetaRight: "CommandOrControl",
  AltLeft: "Alt",
  AltRight: "Alt",
  ShiftLeft: "Shift",
  ShiftRight: "Shift",
};

const keyNames: Record<string, string> = {
  Space: "Space",
  Enter: "Enter",
  Tab: "Tab",
  Escape: "Escape",
  Backspace: "Backspace",
  ArrowUp: "ArrowUp",
  ArrowDown: "ArrowDown",
  ArrowLeft: "ArrowLeft",
  ArrowRight: "ArrowRight",
  PageUp: "PageUp",
  PageDown: "PageDown",
  Home: "Home",
  End: "End",
  Insert: "Insert",
  Delete: "Delete",
};

function keyName(event: KeyboardEvent) {
  if (event.code.startsWith("Key")) return event.code.slice(3).toUpperCase();
  if (event.code.startsWith("Digit")) return event.code.slice(5);
  return keyNames[event.code] || event.code;
}

function modifiersFor(event: KeyboardEvent) {
  return [
    event.ctrlKey || event.metaKey ? "CommandOrControl" : "",
    event.altKey ? "Alt" : "",
    event.shiftKey ? "Shift" : "",
  ].filter(Boolean);
}

function formatHotkey(pending: PendingHotkey) {
  return [...pending.modifiers, pending.key].join("+");
}

function useHotkeyCapture(onChange: (value: string) => void) {
  const [capturing, setCapturing] = useState(false);
  const [pending, setPending] = useState<PendingHotkey | null>(null);

  function begin() {
    setCapturing(true);
    setPending(null);
  }

  function finish(save: boolean) {
    if (save && pending?.key) onChange(formatHotkey(pending));
    setCapturing(false);
    setPending(null);
  }

  function capture(event: KeyboardEvent<HTMLButtonElement>) {
    if (!capturing) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") { finish(false); return; }
    if (event.key === "Enter" || event.code === "Space") { finish(true); return; }
    const modifier = modifierForCode[event.code];
    if (modifier) {
      setPending((current) => ({ modifiers: Array.from(new Set([...(current?.modifiers || []), modifier])), key: current?.key || "" }));
      return;
    }
    setPending({ modifiers: modifiersFor(event), key: keyName(event) });
  }

  return { capturing, pending, begin, capture };
}

function HotkeyButton({ value, placeholder, capturing, pending, begin, capture }: Omit<HotkeyProps, "onChange"> & ReturnType<typeof useHotkeyCapture>) {
  const display = capturing
    ? pending?.key ? `Press Enter or Space to save ${formatHotkey(pending)}` : "Press shortcut keys, then Enter or Space to save"
    : value || placeholder;
  return <button type="button" className={`hotkey-capture${capturing ? " is-recording" : ""}`} onClick={begin} onKeyDown={capture} aria-label={capturing ? "Recording keybind" : `Capture keybind, current ${value || placeholder}`}>
    <span>{display}</span><b>{capturing ? "●" : "⌘"}</b>
  </button>;
}

export function HotkeyCapture({ value, placeholder, onChange }: HotkeyProps) {
  const capture = useHotkeyCapture(onChange);
  return <HotkeyButton value={value} placeholder={placeholder} {...capture} />;
}

const providerLabels: Record<string, string> = {
  catbox: "Catbox",
  imgpile: "ImgPile",
  postimages: "Postimages",
  imgbb: "ImgBB",
  imglink: "ImgLink",
};

const defaultProviders = Object.keys(providerLabels);

export function normalizeProviders(value: string) {
  const providers = value.split(",").map((provider) => provider.trim()).filter(Boolean);
  return Array.from(new Set(providers.length ? providers : defaultProviders));
}

export function reorderProviders(providers: string[], from: number, to: number) {
  if (from === to || from < 0 || to < 0 || from >= providers.length || to >= providers.length) return providers;
  const next = [...providers];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

export function FallbackOrder({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const providers = normalizeProviders(value);
  const [dragged, setDragged] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);

  function move(from: number, to: number) {
    const next = reorderProviders(providers, from, to);
    if (next !== providers) onChange(next.join(","));
    setDragged(null);
    setOver(null);
  }

  function dragStart(index: number, event: DragEvent<HTMLDivElement>) {
    setDragged(index);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", String(index));
  }

  function drop(index: number, event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    const from = dragged ?? Number(event.dataTransfer.getData("text/plain"));
    move(from, index);
  }

  function step(index: number, amount: number) {
    const target = index + amount;
    if (target >= 0 && target < providers.length) move(index, target);
  }

  return <div className="fallback-order">
    <div className="sortable-hint">Drag rows to set fallback order</div>
    <div className="sortable-list" role="list">
      {providers.map((provider, index) => <div
        className={`sortable-item${over === index ? " is-over" : ""}`}
        draggable
        key={provider}
        role="listitem"
        onDragStart={(event) => dragStart(index, event)}
        onDragOver={(event) => { event.preventDefault(); setOver(index); }}
        onDragLeave={() => setOver(null)}
        onDrop={(event) => drop(index, event)}
        onDragEnd={() => { setDragged(null); setOver(null); }}
      >
        <span className="sortable-grip" aria-hidden="true">⠿</span>
        <span className="sortable-name"><strong>{providerLabels[provider] || provider}</strong><code>{provider}</code></span>
        <span className="sortable-actions">
          <button type="button" onClick={() => step(index, -1)} disabled={index === 0} aria-label={`Move ${provider} up`}>↑</button>
          <button type="button" onClick={() => step(index, 1)} disabled={index === providers.length - 1} aria-label={`Move ${provider} down`}>↓</button>
        </span>
      </div>)}
    </div>
  </div>;
}
