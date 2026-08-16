import type { ChatItem } from "../state/store.ts";
import { Markdown } from "./Markdown.tsx";
import { ReasoningBlock } from "./ReasoningBlock.tsx";

export function UserBubble({ item }: { item: Extract<ChatItem, { type: "user" }> }) {
  return (
    <div className="my-3 flex justify-end">
      <div className="max-w-[85%] rounded-2xl rounded-br-sm border border-accent-dim/30 bg-accent-dim/10 px-4 py-2.5">
        <div className="whitespace-pre-wrap text-[0.925rem] text-ink">{item.text}</div>
      </div>
    </div>
  );
}

export function AssistantBubble({ item }: { item: Extract<ChatItem, { type: "assistant" }> }) {
  return (
    <div className="my-3">
      <ReasoningBlock text={item.thinking} streaming={item.streaming} />
      {(item.text || item.streaming) && (
        <div className="max-w-none">
          <Markdown text={item.text || "…"} />
          <div className="mt-1 flex items-center gap-3 text-[0.68rem] text-ink-faint">
            {item.streaming && <span className="animate-pulse text-accent">▍generating</span>}
            {!item.streaming && item.usage?.outputTokens != null && (
              <span>
                {item.usage.model ? `${item.usage.model} · ` : ""}
                {item.usage.inputTokens ?? "?"}→{item.usage.outputTokens} tok
                {item.usage.cost != null ? ` · $${item.usage.cost.toFixed(4)}` : ""}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** Output of a slash command: rendered like a note from the app, not the model. */
export function SystemBubble({ item }: { item: Extract<ChatItem, { type: "system" }> }) {
  return (
    <div className="my-3 rounded-xl border border-border bg-panel-2/60 px-4 py-2.5">
      <div className="mb-1 text-[0.68rem] uppercase tracking-wider text-ink-faint">fastcar</div>
      <div className="text-[0.9rem] text-ink-dim">
        <Markdown text={item.text} />
      </div>
    </div>
  );
}

export function ErrorBubble({ item }: { item: Extract<ChatItem, { type: "error" }> }) {
  return (
    <div className="my-2 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
      ⚠ {item.message}
    </div>
  );
}
