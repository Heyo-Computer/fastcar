import { useEffect, useRef } from "react";
import type { MentionKind } from "@fastcar/shared";
import { suggestionKey, type Suggestion } from "../lib/suggestions.ts";

const MENTION_ICON: Record<MentionKind, string> = {
  agent: "🤖",
  repo: "📦",
  dir: "📁",
  file: "📄",
};

function rowContent(s: Suggestion): { icon: string; label: string; hint?: string; detail?: string } {
  if (s.kind === "command") {
    return {
      icon: "/",
      label: `/${s.spec.name}`,
      hint: s.spec.argHint,
      detail: s.spec.summary,
    };
  }
  return {
    icon: MENTION_ICON[s.item.kind],
    label: s.item.label,
    detail: s.item.detail,
  };
}

/** Autocomplete popup floating above the composer. */
export function SuggestionMenu({
  suggestions,
  active,
  onPick,
  onHover,
}: {
  suggestions: Suggestion[];
  active: number;
  onPick: (s: Suggestion) => void;
  onHover: (index: number) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listRef.current?.children[active]?.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (!suggestions.length) return null;

  return (
    <div className="absolute bottom-full left-0 right-0 mb-2 overflow-hidden rounded-xl border border-border bg-panel shadow-xl shadow-black/40">
      <div ref={listRef} className="max-h-64 overflow-y-auto py-1">
        {suggestions.map((s, i) => {
          const { icon, label, hint, detail } = rowContent(s);
          return (
            <button
              key={suggestionKey(s)}
              // The textarea must keep focus, so take over the mousedown.
              onMouseDown={(e) => {
                e.preventDefault();
                onPick(s);
              }}
              onMouseEnter={() => onHover(i)}
              className={`flex w-full items-baseline gap-2 px-3 py-1.5 text-left text-[0.82rem] ${
                i === active ? "bg-accent-dim/15 text-ink" : "text-ink-dim hover:bg-panel-2/60"
              }`}
            >
              <span className="w-4 shrink-0 text-center text-[0.75rem] text-ink-faint">{icon}</span>
              <span className={`shrink-0 font-mono ${i === active ? "text-accent" : "text-ink"}`}>
                {label}
              </span>
              {hint && <span className="shrink-0 text-[0.72rem] text-ink-faint">{hint}</span>}
              {detail && (
                <span className="ml-auto truncate pl-3 text-right text-[0.72rem] text-ink-faint">
                  {detail}
                </span>
              )}
            </button>
          );
        })}
      </div>
      <div className="border-t border-border px-3 py-1 text-[0.68rem] text-ink-faint">
        ↑↓ navigate · ⏎ or ⇥ select · esc dismiss
      </div>
    </div>
  );
}
