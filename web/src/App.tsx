import { useEffect, useState } from "react";
import { connect } from "./lib/ws.ts";
import { useStore } from "./state/store.ts";
import { parseHash, subscribeRoute } from "./lib/router.ts";
import { Sidebar } from "./components/Sidebar.tsx";
import { AddArtifactModal } from "./components/AddArtifactModal.tsx";
import { SettingsModal } from "./components/SettingsModal.tsx";
import { NewPromptThreadModal } from "./components/NewPromptThreadModal.tsx";
import { InboxView } from "./views/InboxView.tsx";
import { AgentsView } from "./views/AgentsView.tsx";
import { AgentView } from "./views/AgentView.tsx";
import { AgentBuilderView } from "./views/AgentBuilderView.tsx";
import { SchedulesView } from "./views/SchedulesView.tsx";
import { ThreadView } from "./views/ThreadView.tsx";
import { PublicUrlBanner } from "./components/PublicUrlBanner.tsx";

/** A thread route whose thread has not arrived over the wire yet. */
function ThreadRoute({ threadId }: { threadId: string }) {
  const thread = useStore((s) => s.threads.find((t) => t.id === threadId));
  if (!thread) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-ink-faint">Loading…</div>
    );
  }
  return <ThreadView thread={thread} />;
}

export default function App() {
  const route = useStore((s) => s.route);
  const selectedId = useStore((s) => s.selectedId);
  const modal = useStore((s) => s.modal);
  const setRoute = useStore((s) => s.setRoute);
  const loadCommands = useStore((s) => s.loadCommands);
  const loadPromptTemplates = useStore((s) => s.loadPromptTemplates);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  useEffect(() => {
    connect();
    void loadCommands();
    void loadPromptTemplates();
    // The hash is the source of truth; seed from it, then follow it. This is
    // also what makes back/forward and pasted links work.
    setRoute(parseHash());
    return subscribeRoute(setRoute);
  }, [loadCommands, loadPromptTemplates, setRoute]);

  // Close the mobile drawer whenever the route changes.
  useEffect(() => setSidebarOpen(false), [route]);

  return (
    <div className="flex h-full">
      <button
        type="button"
        onClick={() => setSidebarOpen(true)}
        aria-label="Open sidebar"
        className="absolute top-2 left-2 z-30 rounded-lg border border-border bg-panel px-3 py-1.5 text-ink hover:bg-panel-2 sm:hidden"
      >
        ☰
      </button>
      <div
        className={
          "fixed inset-y-0 left-0 z-20 w-72 transform bg-panel transition-transform duration-200 ease-in-out sm:relative sm:z-auto sm:translate-x-0 " +
          (sidebarOpen ? "translate-x-0" : "-translate-x-full")
        }
      >
        <button
          type="button"
          onClick={() => setSidebarOpen(false)}
          aria-label="Close sidebar"
          className="absolute top-2 right-2 text-ink sm:hidden"
        >
          ✕
        </button>
        <Sidebar />
      </div>

      <main className="flex min-w-0 flex-1 flex-col">
        <PublicUrlBanner />
        {route.name === "inbox" && <InboxView filter={route.filter} />}
        {route.name === "agents" && <AgentsView />}
        {route.name === "agent" && <AgentView agentId={route.agentId} tab={route.tab} />}
        {route.name === "agentNew" && <AgentBuilderView />}
        {route.name === "agentEdit" && <AgentBuilderView agentId={route.agentId} />}
        {route.name === "schedules" && <SchedulesView />}
        {route.name === "thread" && <ThreadRoute threadId={route.threadId} />}
      </main>

      {modal === "addArtifact" && selectedId && <AddArtifactModal threadId={selectedId} />}
      {modal === "settings" && <SettingsModal />}
      {modal === "newPrompt" && <NewPromptThreadModal />}
    </div>
  );
}
