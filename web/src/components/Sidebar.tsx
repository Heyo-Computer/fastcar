import { useState } from "react";
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
  /** Thread being renamed inline, and the draft title. */
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  /** Thread awaiting delete confirmation. */
  const [confirming, setConfirming] = useState<string | null>(null);

  const startRename = (t: ThreadMeta) => {
    setConfirming(null);
    setDraft(t.title);
    setRenaming(t.id);
  };

  /** Enter or clicking away saves; Escape is the explicit cancel. */
  const commitRename = (t: ThreadMeta) => {
    const title = draft.trim();
    if (title && title !== t.title) send({ type: "rename_thread", threadId: t.id, title });
    setRenaming(null);
  };

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

  const newPromptThread = () => {
    useStore.getState().setModal("newPrompt");
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
      <button
        onClick={newPromptThread}
        title="Create a prompt thread that runs a template and POSTs the result to a webhook"
        className="mx-3 mb-1 w-[calc(100%-1.5rem)] rounded-lg border border-accent-dim/30 bg-accent-dim/10 px-3 py-1.5 text-sm text-accent hover:bg-accent-dim/20"
      >
        + Prompt thread
      </button>

      <nav className="flex-1 overflow-y-auto px-2 pb-4">
        {groups.map((g) => (
          <div key={g.label}>
            <div className="px-2 pt-3 pb-1 text-[0.7rem] font-medium uppercase tracking-wider text-ink-faint">
              {g.label}
            </div>
            {g.threads.map((t) => (
              <div key={t.id}>
                <div
                  className={`group flex w-full items-center gap-2 rounded-lg px-2 py-2 text-sm ${
                    t.id === selectedId ? "bg-panel-2 text-ink" : "text-ink-dim hover:bg-panel-2/60"
                  }`}
                >
                  <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_DOT[t.status]}`} />
                  {renaming === t.id ? (
                    <input
                      value={draft}
                      autoFocus
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitRename(t);
                        if (e.key === "Escape") setRenaming(null);
                      }}
                      onBlur={() => commitRename(t)}
                      className="min-w-0 flex-1 rounded border border-accent/50 bg-panel px-1.5 py-0.5 text-sm text-ink outline-none"
                    />
                  ) : (
                    <button
                      onClick={() => selectThread(t.id)}
                      onDoubleClick={() => startRename(t)}
                      title={t.title}
                      className="min-w-0 flex-1 truncate text-left"
                    >
                      {t.title}
                    </button>
                  )}
                  {t.mode === "plan" && renaming !== t.id && (
                    <span className="shrink-0 rounded border border-warn/40 px-1 text-[0.6rem] uppercase text-warn">
                      plan
                    </span>
                  )}
                  {renaming !== t.id && (
                    <span className="flex shrink-0 items-center opacity-0 group-hover:opacity-100">
                      <button
                        onClick={() => startRename(t)}
                        title="Rename thread"
                        className="rounded px-1 text-ink-faint hover:bg-panel hover:text-ink"
                      >
                        ✎
                      </button>
                      <button
                        onClick={() => setConfirming(confirming === t.id ? null : t.id)}
                        title="Delete thread"
                        className={`rounded px-1 hover:bg-panel hover:text-danger ${
                          confirming === t.id ? "text-danger opacity-100" : "text-ink-faint"
                        }`}
                      >
                        ×
                      </button>
                    </span>
                  )}
                </div>

                {confirming === t.id && (
                  <div className="mb-1 ml-2 mr-2 rounded-lg border border-danger/30 bg-danger/5 px-2.5 py-2 text-[0.72rem]">
                    <p className="text-ink-dim">
                      Delete this thread, its history, and its agent session? This cannot be undone.
                    </p>
                    <div className="mt-1.5 flex gap-1.5">
                      <button
                        onClick={() => {
                          send({ type: "delete_thread", threadId: t.id });
                          setConfirming(null);
                        }}
                        className="rounded border border-danger/50 bg-danger/10 px-2 py-0.5 text-danger hover:bg-danger/20"
                      >
                        Delete
                      </button>
                      <button
                        onClick={() => setConfirming(null)}
                        className="rounded border border-border px-2 py-0.5 text-ink-dim hover:bg-panel-2"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
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
