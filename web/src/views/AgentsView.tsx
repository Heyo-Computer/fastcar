import { useStore } from "../state/store.ts";
import { navigate } from "../lib/router.ts";

export function AgentsView() {
  const agents = useStore((s) => s.agents);
  const unreadByAgent = useStore((s) => s.unreadByAgent);
  const schedules = useStore((s) => s.schedules);
  const active = agents.filter((a) => !a.archived);
  const archived = agents.filter((a) => a.archived);

  const card = (a: (typeof agents)[number]) => {
    const unread = unreadByAgent[a.id] ?? 0;
    const mine = schedules.filter((s) => s.agentId === a.id && s.enabled);
    // Soonest upcoming run, shown in that schedule's own timezone.
    const soonest = mine
      .filter((s) => s.nextRunAt)
      .sort((x, y) => (x.nextRunAt! < y.nextRunAt! ? -1 : 1))[0];
    return (
      <button
        key={a.id}
        onClick={() => navigate({ name: "agent", agentId: a.id, tab: "threads" })}
        className="flex flex-col gap-1.5 rounded-xl border border-border bg-panel-2/30 p-4 text-left hover:border-accent-dim/40 hover:bg-panel-2/60"
      >
        <span className="flex items-center gap-2">
          <span className="text-lg" aria-hidden>
            {a.avatar ?? "🤖"}
          </span>
          <span className="min-w-0 flex-1 truncate font-medium text-ink">{a.name}</span>
          {a.isBuiltin && (
            <span className="rounded border border-border px-1.5 text-[0.62rem] uppercase text-ink-faint">
              built in
            </span>
          )}
          {unread > 0 && (
            <span className="rounded-full bg-accent-dim/20 px-2 text-[0.68rem] text-accent">{unread}</span>
          )}
        </span>
        <span className="truncate text-[0.78rem] text-ink-dim">
          {a.description || <span className="italic text-ink-faint">No description</span>}
        </span>
        <span className="text-[0.7rem] text-ink-faint">
          {a.resolved.modelSlug} · {a.resolved.tools.length} tools
          {mine.length > 0 &&
            ` · ${mine.length} schedule${mine.length > 1 ? "s" : ""}`}
        </span>
        {soonest && (
          <span className="text-[0.7rem] text-ink-faint">
            Next run{" "}
            {new Date(soonest.nextRunAt!).toLocaleString(undefined, {
              weekday: "short",
              hour: "2-digit",
              minute: "2-digit",
              timeZone: soonest.timezone,
              timeZoneName: "short",
            })}
          </span>
        )}
      </button>
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-center gap-3 border-b border-border bg-panel px-6 py-3">
        <h2 className="font-medium text-ink">Agents</h2>
        <button
          onClick={() => navigate({ name: "agentNew" })}
          className="ml-auto rounded-lg border border-accent-dim/40 bg-accent-dim/20 px-3 py-1.5 text-sm text-accent hover:bg-accent-dim/30"
        >
          + New agent
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{active.map(card)}</div>
        {archived.length > 0 && (
          <>
            <h3 className="mt-8 mb-2 text-[0.72rem] uppercase tracking-wide text-ink-faint">Archived</h3>
            <div className="grid gap-3 opacity-60 sm:grid-cols-2 lg:grid-cols-3">{archived.map(card)}</div>
          </>
        )}
      </div>
    </div>
  );
}
