import { useState } from "react";
import type { SubActivity } from "../state/store.ts";
import { Markdown } from "./Markdown.tsx";

const AGENT_BADGES: Record<string, string> = {
  maxcoding: "border-amber-500/50 text-amber-400",
  minimodel: "border-sky-500/50 text-sky-400",
};

export function SubagentPanel({ sub }: { sub: SubActivity }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="my-1 rounded-md border border-border/70 bg-panel-2/50">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left"
      >
        <span
          className={`rounded border px-1.5 py-px text-[0.65rem] font-medium uppercase tracking-wide ${
            AGENT_BADGES[sub.agent] ?? "border-border text-ink-dim"
          }`}
        >
          {sub.agent}
        </span>
        <span className="text-[0.72rem] text-ink-faint">
          {sub.done ? "finished" : "working…"}
        </span>
        <span className="ml-auto text-xs text-ink-faint">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="border-t border-border/70 px-3 py-2">
          {sub.lines.length > 0 && (
            <pre className="mb-1 whitespace-pre-wrap font-mono text-[0.7rem] text-ink-faint">
              {sub.lines.join("\n")}
            </pre>
          )}
          {sub.text && <Markdown text={sub.text} />}
        </div>
      )}
    </div>
  );
}
