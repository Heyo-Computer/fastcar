import { useEffect, useState } from "react";
import { connect } from "./lib/ws.ts";
import { useStore } from "./state/store.ts";
import { ChatView } from "./components/ChatView.tsx";
import { Composer } from "./components/Composer.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { AddArtifactModal } from "./components/AddArtifactModal.tsx";
import { SettingsModal } from "./components/SettingsModal.tsx";
import { NewPromptThreadModal } from "./components/NewPromptThreadModal.tsx";
import { ArtifactsPanel } from "./components/ArtifactsPanel.tsx";

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

export default function App() {
  const selectedId = useStore((s) => s.selectedId);
  const thread = useStore((s) => s.threads.find((t) => t.id === s.selectedId));
  const modal = useStore((s) => s.modal);
  const setModal = useStore((s) => s.setModal);
  const promptStatus = useStore((s) => (thread ? s.promptStatus[thread.id] : undefined));

  const loadCommands = useStore((s) => s.loadCommands);
  const loadPromptTemplates = useStore((s) => s.loadPromptTemplates);

  useEffect(() => {
    connect();
    void loadCommands();
    void loadPromptTemplates();
  }, [loadCommands, loadPromptTemplates]);

  const [sidebarOpen, setSidebarOpen] = useState(false);

  const promptBadge = promptStatus && PROMPT_STATUS[promptStatus.status];

  return (
    <div className="flex h-full">
      <button
        type="button"
        onClick={() => setSidebarOpen(true)}
        aria-label="Open sidebar"
        className="sm:hidden absolute top-2 left-2 z-30 rounded-lg border border-border bg-panel px-3 py-1.5 text-ink hover:bg-panel-2"
      >
        ☰
      </button>
      <div
        className={
          "fixed inset-y-0 left-0 w-72 bg-panel z-20 transform " +
          (sidebarOpen ? "translate-x-0" : "-translate-x-full") +
          " transition-transform duration-200 ease-in-out sm:relative sm:translate-x-0 sm:z-auto"
        }
      >
        <button
          type="button"
          onClick={() => setSidebarOpen(false)}
          aria-label="Close sidebar"
          className="sm:hidden absolute top-2 right-2 text-ink"
        >
          ✕
        </button>
        <Sidebar />
      </div>
      <main className="flex min-w-0 flex-1 flex-col">
        {thread ? (
          <>
            <header className="flex items-center gap-3 border-b border-border bg-panel px-6 py-3">
              <h2 className="truncate font-medium text-ink">{thread.title}</h2>
              <span
                className={
                  "rounded-full border px-2 py-px text-[0.68rem] " +
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
                <span className="rounded-full border border-warn/40 px-2 py-px text-[0.68rem] uppercase text-warn">
                  planning mode
                </span>
              )}
              {thread.threadType === "prompt" && (
                <span className="rounded-full border border-accent-dim/40 px-2 py-px text-[0.68rem] uppercase text-accent">
                  prompt
                </span>
              )}
              {promptBadge && (
                <span
                  className={"rounded-full border px-2 py-px text-[0.68rem] " + promptBadge.cls}
                  title={promptStatus?.response}
                >
                  {promptBadge.label}
                </span>
              )}
              <button
                onClick={() => setModal("settings")}
                title="Settings"
                className="ml-auto rounded-lg border border-border px-2 py-1 text-sm text-ink-faint hover:bg-panel-2 hover:text-ink"
              >
                ⚙
              </button>
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
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 text-ink-faint">
            <span className="text-4xl">🏎️</span>
            <p className="text-lg text-ink-dim">fastcar</p>
            <p className="max-w-sm text-center text-sm">
              A conductor agent on Mercury with maxcoding & minimodel subagents.
              {selectedId ? "" : " Select a thread on the left, or start a new one."}
            </p>
            <button
              onClick={() => setModal("newPrompt")}
              className="mt-2 rounded-lg border border-accent-dim/40 bg-accent-dim/20 px-4 py-1.5 text-sm text-accent hover:bg-accent-dim/30"
            >
              + Prompt thread
            </button>
          </div>
        )}
      </main>

      {modal === "addArtifact" && selectedId && (
        <AddArtifactModal threadId={selectedId} />
      )}
      {modal === "settings" && <SettingsModal />}
      {modal === "newPrompt" && <NewPromptThreadModal />}
    </div>
  );
}
