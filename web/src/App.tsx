import { useEffect } from "react";
import { connect } from "./lib/ws.ts";
import { useStore } from "./state/store.ts";
import { ChatView } from "./components/ChatView.tsx";
import { Composer } from "./components/Composer.tsx";
import { Sidebar } from "./components/Sidebar.tsx";

const STATUS_LABELS: Record<string, string> = {
  idle: "idle",
  running: "working",
  awaiting_input: "waiting for your answer",
  awaiting_approval: "plan awaiting approval",
};

export default function App() {
  const selectedId = useStore((s) => s.selectedId);
  const thread = useStore((s) => s.threads.find((t) => t.id === s.selectedId));

  const loadCommands = useStore((s) => s.loadCommands);

  useEffect(() => {
    connect();
    void loadCommands();
  }, [loadCommands]);

  return (
    <div className="flex h-full">
      <Sidebar />
      <main className="flex min-w-0 flex-1 flex-col">
        {thread ? (
          <>
            <header className="flex items-center gap-3 border-b border-border bg-panel px-6 py-3">
              <h2 className="truncate font-medium text-ink">{thread.title}</h2>
              <span
                className={`rounded-full border px-2 py-px text-[0.68rem] ${
                  thread.status === "running"
                    ? "border-accent/40 text-accent"
                    : thread.status === "idle"
                      ? "border-border text-ink-faint"
                      : "border-warn/40 text-warn"
                }`}
              >
                {STATUS_LABELS[thread.status]}
              </span>
              {thread.mode === "plan" && (
                <span className="rounded-full border border-warn/40 px-2 py-px text-[0.68rem] uppercase text-warn">
                  planning mode
                </span>
              )}
            </header>
            <ChatView thread={thread} />
            <Composer thread={thread} />
          </>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 text-ink-faint">
            <span className="text-4xl">🏎️</span>
            <p className="text-lg text-ink-dim">fastcar</p>
            <p className="max-w-sm text-center text-sm">
              A conductor agent on Mercury with maxcoding & minimodel subagents.
              {selectedId ? "" : " Select a thread on the left, or start a new one."}
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
