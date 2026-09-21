import type { ThreadMeta } from "@fastcar/shared";
import { useStore } from "../state/store.ts";
import { navigate } from "../lib/router.ts";
import { ChatView } from "../components/ChatView.tsx";
import { Composer } from "../components/Composer.tsx";
import { ArtifactsPanel } from "../components/ArtifactsPanel.tsx";

const STATUS_LABELS: Record<string, string> = {
  idle: "idle",
  running: "working",
  awaiting_input: "waiting for your answer",
  awaiting_approval: "plan awaiting approval",
};

const PROMPT_STATUS: Record<string, { label: string; cls: string }> = {
  pending: { label: "webhook pending", cls: "border-warn/40 text-warn" },
  success: { label: "webhook delivered", cls: "border-accent/40 text-accent" },
  error: { label: "webhook failed", cls: "border-danger/40 text-danger" },
  skipped: { label: "webhook skipped", cls: "border-border text-ink-faint" },
};

/** The original single-view layout, now one route among several. */
export function ThreadView({ thread }: { thread: ThreadMeta }) {
  const promptStatus = useStore((s) => s.promptStatus[thread.id]);
  const agents = useStore((s) => s.agents);
  const agent = agents.find((a) => a.id === thread.agentId);
  const promptBadge = promptStatus && PROMPT_STATUS[promptStatus.status];

  return (
    <>
      <header className="flex items-center gap-3 border-b border-border bg-panel px-6 py-3">
        {agent && (
          <button
            onClick={() => navigate({ name: "agent", agentId: agent.id, tab: "threads" })}
            title={`Open ${agent.name}`}
            className="flex shrink-0 items-center gap-1.5 rounded-lg border border-border px-2 py-1 text-[0.72rem] text-ink-dim hover:bg-panel-2 hover:text-ink"
          >
            <span aria-hidden>{agent.avatar ?? "🤖"}</span>
            {agent.name}
          </button>
        )}
        <h2 className="truncate font-medium text-ink">{thread.title}</h2>
        <span
          className={
            "shrink-0 rounded-full border px-2 py-px text-[0.68rem] " +
            (thread.status === "running"
              ? "border-accent/40 text-accent"
              : thread.status === "idle"
                ? "border-border text-ink-faint"
                : "border-warn/40 text-warn")
          }
        >
          {STATUS_LABELS[thread.status]}
        </span>
        {thread.mode === "plan" && (
          <span className="shrink-0 rounded-full border border-warn/40 px-2 py-px text-[0.68rem] uppercase text-warn">
            planning mode
          </span>
        )}
        {thread.source === "schedule" && (
          <span className="shrink-0 rounded-full border border-border px-2 py-px text-[0.68rem] uppercase text-ink-faint">
            scheduled
          </span>
        )}
        {thread.threadType === "prompt" && (
          <span className="shrink-0 rounded-full border border-accent-dim/40 px-2 py-px text-[0.68rem] uppercase text-accent">
            prompt
          </span>
        )}
        {promptBadge && (
          <span
            className={"shrink-0 rounded-full border px-2 py-px text-[0.68rem] " + promptBadge.cls}
            title={promptStatus?.response}
          >
            {promptBadge.label}
          </span>
        )}
      </header>
      <ChatView thread={thread} />
      {thread.threadType === "prompt" && promptStatus && (
        <div className="border-t border-border bg-panel px-6 py-2 text-[0.72rem] text-ink-dim">
          <span className="text-ink-faint">Webhook:</span>{" "}
          {promptStatus.response ?? promptStatus.status}
        </div>
      )}
      <ArtifactsPanel threadId={thread.id} />
      <Composer thread={thread} />
    </>
  );
}
