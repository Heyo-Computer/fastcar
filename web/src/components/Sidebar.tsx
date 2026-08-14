import type { ThreadMeta } from "@fastcar/shared";
import { useStore } from "../state/store.ts";
import { send } from "../lib/ws.ts";
import { RepoPanel } from "./RepoPanel.tsx";

function groupLabel(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.floor((startOfDay(now) - startOfDay(d)) / 86_400_000);
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

export function Sidebar() {
  const threads = useStore((s) => s.threads);
  const selectedId = useStore((s) => s.selectedId);
  const selectThread = useStore((s) => s.selectThread);
  const connection = useStore((s) => s.connection);

  const groups: Array<{ label: string; threads: ThreadMeta[] }> = [];
  for (const t of threads) {
    const label = groupLabel(t.updatedAt);
    const g = groups.find((g) => g.label === label);
    if (g) g.threads.push(t);
    else groups.push({ label, threads: [t] });
  }

  const newThread = (mode: "act" | "plan") => {
    useStore.setState({ awaitingCreatedThread: true });
    send({ type: "create_thread", mode });
  };

  return (
    <aside className="flex h-full w-72 shrink-0 flex-col border-r border-border bg-panel">
      <div className="flex items-center gap-2 px-4 py-3.5 border-b border-border">
        <span className="text-lg">🏎️</span>
        <h1 className="font-semibold tracking-wide text-ink">fastcar</h1>
        <span
          className={`ml-auto h-2 w-2 rounded-full ${
            connection === "open" ? "bg-accent" : connection === "connecting" ? "bg-warn" : "bg-danger"
          }`}
          title={`connection: ${connection}`}
        />
      </div>

      <div className="flex gap-2 p-3">
        <button
          onClick={() => newThread("act")}
          className="flex-1 rounded-lg bg-accent-dim/20 border border-accent-dim/40 px-3 py-1.5 text-sm text-accent hover:bg-accent-dim/30"
        >
          + New thread
        </button>
        <button
          onClick={() => newThread("plan")}
          title="Start in planning mode"
          className="rounded-lg border border-border px-3 py-1.5 text-sm text-ink-dim hover:bg-panel-2"
        >
          Plan
        </button>
      </div>

      <nav className="flex-1 overflow-y-auto px-2 pb-4">
        {groups.map((g) => (
          <div key={g.label}>
            <div className="px-2 pt-3 pb-1 text-[0.7rem] font-medium uppercase tracking-wider text-ink-faint">
              {g.label}
            </div>
            {g.threads.map((t) => (
              <button
                key={t.id}
                onClick={() => selectThread(t.id)}
                className={`group flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm ${
                  t.id === selectedId ? "bg-panel-2 text-ink" : "text-ink-dim hover:bg-panel-2/60"
                }`}
              >
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_DOT[t.status]}`} />
                <span className="truncate">{t.title}</span>
                {t.mode === "plan" && (
                  <span className="ml-auto shrink-0 rounded border border-warn/40 px-1 text-[0.6rem] uppercase text-warn">
                    plan
                  </span>
                )}
              </button>
            ))}
          </div>
        ))}
        {!threads.length && (
          <p className="px-3 py-6 text-center text-sm text-ink-faint">
            No threads yet.
            <br />
            Start one above.
          </p>
        )}
      </nav>

      <RepoPanel />
    </aside>
  );
}
