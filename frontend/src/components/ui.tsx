import { forwardRef, useEffect, useRef, useState } from "react";
import type { ButtonHTMLAttributes, InputHTMLAttributes, LabelHTMLAttributes, TextareaHTMLAttributes } from "react";
import type { ReactNode } from "react";

export function Label({ className = "", ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={`label ${className}`} {...props} />;
}

export function Button({ className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button className={`button ${className}`} {...props} />;
}

export function Input({ className = "", ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`input ${className}`} {...props} />;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className = "", ...props }, ref) => (
  <textarea ref={ref} className={`textarea ${className}`} {...props} />
));

type Option = { value: string; label: string };

// shadcn/ui-style Select: custom trigger + popover list (Radix-free).
export function Select({ value, onValueChange, options, id }: { value: string; onValueChange: (value: string) => void; options: Option[]; id?: string }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const selected = options.find((option) => option.value === value);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);

  return <div className="select-wrap" ref={root}>
    <button type="button" id={id} className="select" data-open={open} aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
      <span>{selected?.label ?? "Select…"}</span>
      <svg className="select-chevron" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
    </button>
    {open && <div className="select-content" role="listbox">
      {options.map((option) => <div key={option.value} role="option" aria-selected={option.value === value} className="select-item" data-selected={option.value === value} onClick={() => { onValueChange(option.value); setOpen(false); }}>
        <svg className="select-check" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg>
        <span>{option.label}</span>
      </div>)}
    </div>}
  </div>;
}

export function Card({ className = "", children }: { className?: string; children: ReactNode }) {
  return <section className={`card ${className}`}>{children}</section>;
}

export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "live" }) {
  return <span className={`badge badge-${tone}`}><i />{children}</span>;
}

export function Switch({ checked, onCheckedChange, id }: { checked: boolean; onCheckedChange: (value: boolean) => void; id?: string }) {
  return <button type="button" role="switch" aria-checked={checked} id={id} className="switch" data-on={checked} onClick={() => onCheckedChange(!checked)}>
    <span className="switch-thumb" />
  </button>;
}

// HugeIcons "chat-gpt" (stroke). Inlined — one icon isn't worth the package.
export function GptIcon({ size = 22 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M11.745 14.85L6.905 12V7c0-2.21 1.824-4 4.076-4c1.397 0 2.63.69 3.365 1.741" />
    <path d="M9.6 19.18A4.1 4.1 0 0 0 13.02 21c2.25 0 4.076-1.79 4.076-4v-5L12.16 9.097" />
    <path d="M9.452 13.5V7.67l4.412-2.5c1.95-1.105 4.443-.45 5.569 1.463a3.93 3.93 0 0 1 .076 3.866" />
    <path d="M4.49 13.5a3.93 3.93 0 0 0 .075 3.866c1.126 1.913 3.62 2.568 5.57 1.464l4.412-2.5l.096-5.596" />
    <path d="M17.096 17.63a4.09 4.09 0 0 0 3.357-1.996c1.126-1.913.458-4.36-1.492-5.464l-4.413-2.5l-5.059 2.755" />
    <path d="M6.905 6.37a4.09 4.09 0 0 0-3.358 1.996c-1.126 1.914-.458 4.36 1.492 5.464l4.413 2.5l5.048-2.75" />
  </svg>;
}
