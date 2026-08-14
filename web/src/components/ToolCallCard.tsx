import { useState } from "react";
import type { ChatItem } from "../state/store.ts";
import { SubagentPanel } from "./SubagentPanel.tsx";

const TOOL_ICONS: Record<string, string> = {
  bash: "❯_",
  read: "📄",
  write: "✏️",
  edit: "✏️",
  grep: "🔍",
  find: "🔍",
  ls: "📁",
  web_search: "🌐",
  run_subagent: "🤖",
  ask_user: "❓",
  submit_plan: "📋",
  memory_save: "🧠",
  memory_search: "🧠",
  memory_list: "🧠",
  memory_delete: "🧠",
};

export function ToolCallCard({ item }: { item: Extract<ChatItem, { type: "tool" }> }) {
  const [open, setOpen] = useState(false);
  const icon = TOOL_ICONS[item.name] ?? "🔧";
  const status = !item.done ? (
    <span className="text-accent animate-pulse">running…</span>
  ) : item.ok ? (
    <span className="text-ink-faint">done</span>
  ) : (
    <span className="text-danger">error</span>
  );

  const argsPreview = (() => {
    try {
      const s = JSON.stringify(item.args);
      return s === "{}" ? "" : s.length > 100 ? `${s.slice(0, 100)}…` : s;
    } catch {
      return "";
    }
  })();

  return (
    <div className="my-1.5 rounded-lg border border-border bg-panel">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm"
      >
        <span className="text-xs">{icon}</span>
        <span className="font-mono text-[0.8rem] text-ink">{item.name}</span>
        <span className="truncate font-mono text-[0.72rem] text-ink-faint">{argsPreview}</span>
        <span className="ml-auto shrink-0 text-[0.72rem]">{status}</span>
        <span className="text-ink-faint text-xs">{open ? "▾" : "▸"}</span>
      </button>

      {item.subs.length > 0 && (
        <div className="border-t border-border px-3 py-2">
          {item.subs.map((sub) => (
            <SubagentPanel key={sub.taskId} sub={sub} />
          ))}
        </div>
      )}

      {open && (
        <div className="border-t border-border px-3 py-2">
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap font-mono text-[0.72rem] text-ink-dim">
            {JSON.stringify(item.args, null, 2)}
          </pre>
          {(item.result || item.output) && (
            <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap border-t border-border pt-2 font-mono text-[0.72rem] text-ink-dim">
              {item.result || item.output}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
