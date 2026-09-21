import { useEffect, useState } from "react";
import type { ArtifactNode, ThreadMeta } from "@fastcar/shared";
import { useStore } from "../state/store.ts";
import { send } from "../lib/ws.ts";
import { navigate, type AgentTab } from "../lib/router.ts";
import { ScheduleList } from "./SchedulesView.tsx";

const TABS: Array<{ id: AgentTab; label: string }> = [
  { id: "threads", label: "Threads" },
  { id: "output", label: "Output" },
  { id: "schedules", label: "Schedules" },
];

function groupLabel(iso: string): string {
  const d = new Date(iso);
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.floor((start(new Date()) - start(d)) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return "This week";
  if (days < 30) return "This month";
  return "Earlier";
}

const STATUS_DOT: Record<ThreadMeta["status"], string> = {
  idle: "bg-ink-faint",
  running: "bg-accent animate-pulse",
  awaiting_input: "bg-warn",
  awaiting_approval: "bg-warn",
};

/** Every artifact this agent has produced, newest first, across its threads. */
function OutputTab({ agentId }: { agentId: string }) {
  const [rows, setRows] = useState<Array<ArtifactNode & { threadTitle: string }> | null>(null);
  useEffect(() => {
    let live = true;
    void fetch(`/api/agents/${agentId}/artifacts`)
      .then((r) => (r.ok ? r.json() : { artifacts: [] }))
      .then((d) => live && setRows(d.artifacts))
      .catch(() => live && setRows([]));
    return () => {
      live = false;
    };
  }, [agentId]);

  if (!rows) return <p className="px-6 py-8 text-sm text-ink-faint">Loading…</p>;
  if (!rows.length) {
    return (
      <p className="px-6 py-8 text-sm text-ink-faint">
        Nothing published yet. Artifacts this agent creates show up here, newest first.
      </p>
    );
  }
  return (
    <ul className="divide-y divide-border/60">
      {rows.map((a) => (
        <li key={a.id} className="flex items-center gap-3 px-6 py-2.5">
          <a
            href={a.publicUrl}
            target="_blank"
            rel="noreferrer"
            className="min-w-0 flex-1 truncate text-sm text-accent hover:underline"
          >
            {a.name}
          </a>
          <button
            onClick={() => navigate({ name: "thread", threadId: a.threadId })}
            className="shrink-0 truncate text-[0.72rem] text-ink-faint hover:text-ink"
            title="Open the run that produced it"
          >
            {a.threadTitle}
          </button>
          <span className="shrink-0 text-[0.68rem] text-ink-faint">
            {new Date(a.createdAt).toLocaleDateString()}
          </span>
        </li>
      ))}
    </ul>
  );
}

function ThreadsTab({ agentId }: { agentId: string }) {
  const threads = useStore((s) => s.threads);
  const loadThreadsForAgent = useStore((s) => s.loadThreadsForAgent);

  useEffect(() => {
    void loadThreadsForAgent(agentId);
  }, [agentId, loadThreadsForAgent]);

  // Filtered here, not in a selector: a selector returning a fresh array
  // loops useSyncExternalStore (see ArtifactsPanel.tsx).
  const mine = threads.filter((t) => t.agentId === agentId);

  const groups: Array<{ label: string; items: ThreadMeta[] }> = [];
  for (const t of mine) {
    const label = groupLabel(t.updatedAt);
    const g = groups.find((x) => x.label === label);
    if (g) g.items.push(t);
    else groups.push({ label, items: [t] });
  }

  if (!mine.length) {
    return (
      <div className="px-6 py-8">
        <p className="text-sm text-ink-faint">No threads yet.</p>
        <button
          onClick={() => {
            useStore.setState({ awaitingCreatedThread: true });
            send({ type: "create_thread", mode: "act", agentId });
          }}
          className="mt-3 rounded-lg border border-accent-dim/40 bg-accent-dim/20 px-3 py-1.5 text-sm text-accent hover:bg-accent-dim/30"
        >
          + Start a thread
        </button>
      </div>
    );
  }

  return (
    <div className="pb-6">
      {groups.map((g) => (
        <div key={g.label}>
          <div className="px-6 pt-4 pb-1 text-[0.68rem] font-medium uppercase tracking-wider text-ink-faint">
            {g.label}
          </div>
          {g.items.map((t) => (
            <button
              key={t.id}
              onClick={() => navigate({ name: "thread", threadId: t.id })}
              className="flex w-full items-center gap-2.5 px-6 py-2 text-left text-sm text-ink-dim hover:bg-panel-2/60"
            >
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_DOT[t.status]}`} />
              <span className="min-w-0 flex-1 truncate">{t.title}</span>
              {t.source === "schedule" && (
                <span className="shrink-0 rounded border border-border px-1 text-[0.6rem] uppercase text-ink-faint">
                  sched
                </span>
              )}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

export function AgentView({ agentId, tab }: { agentId: string; tab: AgentTab }) {
  const agents = useStore((s) => s.agents);
  const unreadByAgent = useStore((s) => s.unreadByAgent);
  const agent = agents.find((a) => a.id === agentId);
  const unread = unreadByAgent[agentId] ?? 0;

  if (!agent) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-ink-faint">
        No such agent.
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="border-b border-border bg-panel px-6 pt-4">
        <div className="flex items-center gap-3">
          <span className="text-xl" aria-hidden>
            {agent.avatar ?? "🤖"}
          </span>
          <div className="min-w-0">
            <h2 className="truncate font-medium text-ink">{agent.name}</h2>
            <p className="truncate text-[0.72rem] text-ink-faint">
              {agent.resolved.modelProvider}/{agent.resolved.modelSlug} ·{" "}
              {agent.resolved.reasoningEffort} effort · {agent.resolved.tools.length} tools
              {agent.isBuiltin ? " · built in" : ""}
            </p>
          </div>
          {unread > 0 && (
            <span className="rounded-full bg-accent-dim/20 px-2 py-px text-[0.68rem] text-accent">
              {unread} unread
            </span>
          )}
          <div className="ml-auto flex gap-2">
            <button
              onClick={() => {
                useStore.setState({ awaitingCreatedThread: true });
                send({ type: "create_thread", mode: "act", agentId });
              }}
              className="rounded-lg border border-accent-dim/40 bg-accent-dim/20 px-3 py-1.5 text-sm text-accent hover:bg-accent-dim/30"
            >
              + Thread
            </button>
            <button
              onClick={() => navigate({ name: "agentEdit", agentId })}
              className="rounded-lg border border-border px-3 py-1.5 text-sm text-ink-dim hover:bg-panel-2 hover:text-ink"
            >
              {agent.isBuiltin ? "View" : "Edit"}
            </button>
          </div>
        </div>
        <nav className="mt-3 flex gap-1">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => navigate({ name: "agent", agentId, tab: t.id })}
              className={
                "rounded-t-lg border-b-2 px-3 py-1.5 text-[0.78rem] " +
                (tab === t.id
                  ? "border-accent text-ink"
                  : "border-transparent text-ink-faint hover:text-ink-dim")
              }
            >
              {t.label}
            </button>
          ))}
        </nav>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === "threads" && <ThreadsTab agentId={agentId} />}
        {tab === "output" && <OutputTab agentId={agentId} />}
        {tab === "schedules" && <ScheduleList agentId={agentId} />}
      </div>
    </div>
  );
}
