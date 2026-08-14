import { useState } from "react";

export function ReasoningBlock({ text, streaming }: { text: string; streaming: boolean }) {
  const [open, setOpen] = useState(false);
  if (!text) return null;
  return (
    <div className="my-1 rounded-lg border border-border/60 bg-panel/60">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[0.72rem] text-ink-faint"
      >
        <span className={streaming ? "animate-pulse" : ""}>💭 reasoning</span>
        <span className="ml-auto">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="whitespace-pre-wrap border-t border-border/60 px-3 py-2 text-[0.78rem] italic text-ink-dim">
          {text}
        </div>
      )}
    </div>
  );
}
