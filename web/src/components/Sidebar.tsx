import { useStore } from "../state/store.ts";
import { navigate, type Route } from "../lib/router.ts";

/**
 * Agent-centric navigation. The flat thread list this used to be now lives in
 * each agent's Threads tab — with several agents producing output on their own
 * schedules, "every thread, newest first" stopped being a useful index.
 */
function NavButton({
  active,
  onClick,
  icon,
  label,
  badge,
}: {
  active: boolean;
  onClick: () => void;
  icon: string;
  label: string;
  badge?: number;
}) {
  return (
    <button
      onClick={onClick}
      className={
        "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm " +
        (active ? "bg-panel-2 text-ink" : "text-ink-dim hover:bg-panel-2/60")
      }
    >
      <span className="w-4 text-center" aria-hidden>
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      {badge !== undefined && badge > 0 && (
        <span className="shrink-0 rounded-full bg-accent-dim/20 px-1.5 text-[0.66rem] text-accent">
          {badge}
        </span>
      )}
    </button>
  );
}

function isOn(route: Route, name: Route["name"], agentId?: string): boolean {
  if (route.name !== name) return false;
  if (agentId && "agentId" in route) return route.agentId === agentId;
  return true;
}

export function Sidebar() {
  const route = useStore((s) => s.route);
  const connection = useStore((s) => s.connection);
  const agents = useStore((s) => s.agents);
  const unreadByAgent = useStore((s) => s.unreadByAgent);
  const totalUnread = useStore((s) => s.totalUnread);
  const setModal = useStore((s) => s.setModal);

  const active = agents.filter((a) => !a.archived);

  return (
    <aside className="flex h-full w-72 shrink-0 flex-col border-r border-border bg-panel">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3.5">
        <span className="text-lg">🏎️</span>
        <h1 className="font-semibold tracking-wide text-ink">fastcar</h1>
        <span
          className={`ml-auto h-2 w-2 rounded-full ${
            connection === "open" ? "bg-accent" : connection === "connecting" ? "bg-warn" : "bg-danger"
          }`}
          title={`connection: ${connection}`}
        />
      </div>

      <nav className="space-y-0.5 p-2">
        <NavButton
          active={route.name === "inbox"}
          onClick={() => navigate({ name: "inbox", filter: "all" })}
          icon="📥"
          label="Inbox"
          badge={totalUnread}
        />
        <NavButton
          active={route.name === "agents"}
          onClick={() => navigate({ name: "agents" })}
          icon="🤖"
          label="Agents"
        />
        <NavButton
          active={route.name === "schedules"}
          onClick={() => navigate({ name: "schedules" })}
          icon="⏰"
          label="Schedules"
        />
      </nav>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <div className="px-2.5 pt-2 pb-1 text-[0.68rem] font-medium uppercase tracking-wider text-ink-faint">
          Your agents
        </div>
        {active.map((a) => (
          <NavButton
            key={a.id}
            active={isOn(route, "agent", a.id) || isOn(route, "agentEdit", a.id)}
            onClick={() => navigate({ name: "agent", agentId: a.id, tab: "threads" })}
            icon={a.avatar ?? "🤖"}
            label={a.name}
            badge={unreadByAgent[a.id] ?? 0}
          />
        ))}
        <button
          onClick={() => navigate({ name: "agentNew" })}
          className="mt-1 w-full rounded-lg border border-dashed border-border px-2.5 py-1.5 text-left text-[0.8rem] text-ink-faint hover:border-accent-dim/40 hover:text-accent"
        >
          + New agent
        </button>
      </div>

      <div className="border-t border-border p-2">
        <button
          onClick={() => setModal("settings")}
          className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm text-ink-dim hover:bg-panel-2/60"
        >
          <span className="w-4 text-center" aria-hidden>
            ⚙
          </span>
          Settings
        </button>
      </div>
    </aside>
  );
}
