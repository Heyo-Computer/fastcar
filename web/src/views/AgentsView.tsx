import { useCallback, useEffect, useState } from "react";
import type { AgentTemplatesResponse, InstallAgentTemplateResponse } from "@fastcar/shared";
import { useStore } from "../state/store.ts";
import { navigate } from "../lib/router.ts";

/**
 * Ready-made agents (server/src/services/agentTemplates.ts). Installing one
 * creates an editable agent plus a *disabled* schedule, then opens the agent
 * so the user can review its prompt before switching the schedule on.
 */
function TemplatesSection() {
  const [data, setData] = useState<AgentTemplatesResponse | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [crm, setCrm] = useState("loopscrm");

  const load = useCallback(async () => {
    const res = await fetch("/api/agent-templates");
    if (res.ok) setData((await res.json()) as AgentTemplatesResponse);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  if (!data || data.templates.length === 0) return null;
  const crmMissing = !data.mcpServers.includes(crm);

  const install = async (id: string) => {
    setBusy(id);
    setError(null);
    try {
      const res = await fetch(`/api/agent-templates/${id}/install`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ crmServer: crm, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
      });
      const body = (await res.json()) as InstallAgentTemplateResponse & { error?: string };
      if (!res.ok) {
        setError(body.error ?? `Install failed (${res.status})`);
        return;
      }
      const store = useStore.getState();
      await Promise.all([store.loadAgents(), store.loadSchedules(), load()]);
      navigate({ name: "agent", agentId: body.agent.id, tab: "schedules" });
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="mb-8">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h3 className="text-[0.72rem] uppercase tracking-wide text-ink-faint">Sales templates</h3>
        <label className="ml-auto flex items-center gap-1.5 text-[0.72rem] text-ink-faint">
          CRM MCP server
          <input
            value={crm}
            onChange={(e) => setCrm(e.target.value.trim())}
            className="w-28 rounded border border-border bg-panel px-1.5 py-0.5 text-ink"
          />
        </label>
      </div>
      {crmMissing && (
        <p className="mb-2 text-[0.75rem] text-ink-dim">
          These agents work LoopsCRM over MCP. Install it first under the name “{crm}”: MCP panel → your CRM’s{" "}
          <code>/mcp</code> URL with header <code>Authorization: Bearer &lt;app-token&gt;</code>.
        </p>
      )}
      {error && <p className="mb-2 text-[0.75rem] text-red-400">{error}</p>}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {data.templates.map((t) => (
          <div key={t.id} className="flex min-w-0 flex-col gap-1.5 rounded-xl border border-dashed border-border p-4">
            <span className="flex items-center gap-2">
              <span className="text-lg" aria-hidden>
                {t.avatar}
              </span>
              <span className="min-w-0 flex-1 truncate font-medium text-ink">{t.name}</span>
            </span>
            <span className="break-words text-[0.78rem] text-ink-dim">{t.description}</span>
            {t.schedule && (
              <span className="text-[0.7rem] text-ink-faint">
                Schedule <code>{t.schedule.cron}</code>, created off
              </span>
            )}
            {t.installedAgentId ? (
              <button
                onClick={() => navigate({ name: "agent", agentId: t.installedAgentId!, tab: "threads" })}
                className="mt-1 self-start text-[0.75rem] text-accent hover:underline"
              >
                Installed — open
              </button>
            ) : (
              <button
                disabled={busy !== null || crmMissing}
                onClick={() => void install(t.id)}
                className="mt-1 self-start rounded-lg border border-accent-dim/40 bg-accent-dim/20 px-3 py-1 text-[0.78rem] text-accent hover:bg-accent-dim/30 disabled:opacity-40"
              >
                {busy === t.id ? "Installing…" : "Install"}
              </button>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

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
        className="flex min-w-0 flex-col gap-1.5 rounded-xl border border-border bg-panel-2/30 p-4 text-left hover:border-accent-dim/40 hover:bg-panel-2/60"
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
        <span className="line-clamp-2 break-words text-[0.78rem] text-ink-dim">
          {a.description || <span className="italic text-ink-faint">No description</span>}
        </span>
        <span className="break-words text-[0.7rem] text-ink-faint">
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
      <header className="flex items-center gap-3 border-b border-border bg-panel py-3 pr-4 pl-16 sm:px-6">
        <h2 className="font-medium text-ink">Agents</h2>
        <button
          onClick={() => navigate({ name: "agentNew" })}
          className="ml-auto rounded-lg border border-accent-dim/40 bg-accent-dim/20 px-3 py-1.5 text-sm text-accent hover:bg-accent-dim/30"
        >
          + New agent
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
        <TemplatesSection />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">{active.map(card)}</div>
        {archived.length > 0 && (
          <>
            <h3 className="mt-8 mb-2 text-[0.72rem] uppercase tracking-wide text-ink-faint">Archived</h3>
            <div className="grid grid-cols-1 gap-3 opacity-60 sm:grid-cols-2 lg:grid-cols-3">{archived.map(card)}</div>
          </>
        )}
      </div>
    </div>
  );
}
