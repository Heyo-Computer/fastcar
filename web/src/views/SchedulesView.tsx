import { useEffect, useState } from "react";
import type { Schedule } from "@fastcar/shared";
import { useStore } from "../state/store.ts";
import { navigate } from "../lib/router.ts";

/**
 * Presets are the primary way to build a schedule: "every morning" is what
 * people actually want, and a raw cron field invites the mistakes the DST
 * tests exist to catch. Raw cron stays available behind a disclosure.
 */
const PRESETS: Array<{ label: string; cron: (hh: string, mm: string, dow: string) => string; needsDow?: boolean }> = [
  { label: "Every day", cron: (hh, mm) => `${mm} ${hh} * * *` },
  { label: "Every weekday", cron: (hh, mm) => `${mm} ${hh} * * 1-5` },
  { label: "Every week", cron: (hh, mm, dow) => `${mm} ${hh} * * ${dow}`, needsDow: true },
  { label: "Every hour", cron: (_hh, mm) => `${mm} * * * *` },
];

const DOWS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const STATUS_CLS: Record<string, string> = {
  ok: "border-accent/40 text-accent",
  error: "border-danger/40 text-danger",
  running: "border-warn/40 text-warn",
  skipped: "border-border text-ink-faint",
};

/**
 * Render in the schedule's own timezone, not the viewer's. Someone who set
 * "07:00 America/Los_Angeles" and is shown "08:00" has to work out whose clock
 * that is; showing 07:00 with the zone named is the answer they asked for.
 */
function when(iso: string | null, timeZone?: string): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    ...(timeZone ? { timeZone, timeZoneName: "short" } : {}),
  });
}

function ScheduleEditor({
  agentId,
  existing,
  onDone,
}: {
  agentId?: string;
  existing?: Schedule;
  onDone: () => void;
}) {
  const agents = useStore((s) => s.agents);
  const [name, setName] = useState(existing?.name ?? "Morning brief");
  const [targetAgent, setTargetAgent] = useState(existing?.agentId ?? agentId ?? "");
  const [prompt, setPrompt] = useState(existing?.prompt ?? "");
  const [preset, setPreset] = useState(0);
  const [hh, setHh] = useState("07");
  const [mm, setMm] = useState("00");
  const [dow, setDow] = useState("1");
  const [raw, setRaw] = useState(existing?.cron ?? "");
  const [useRaw, setUseRaw] = useState(Boolean(existing));
  const [timezone, setTimezone] = useState(
    existing?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC",
  );
  const [webhookUrl, setWebhookUrl] = useState(existing?.webhookUrl ?? "");
  const [webhookToken, setWebhookToken] = useState("");
  const [preview, setPreview] = useState<{ valid: boolean; error?: string; nextRuns: string[] }>({
    valid: true,
    nextRuns: [],
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cron = useRaw ? raw : PRESETS[preset]!.cron(hh, mm, dow);

  // Preview is server-side so the form and the scheduler agree on what a cron
  // means, DST included.
  useEffect(() => {
    if (!cron.trim()) return;
    const t = setTimeout(() => {
      void fetch(`/api/schedules/preview?cron=${encodeURIComponent(cron)}&timezone=${encodeURIComponent(timezone)}`)
        .then((r) => r.json())
        .then(setPreview)
        .catch(() => setPreview({ valid: false, error: "could not validate", nextRuns: [] }));
    }, 250);
    return () => clearTimeout(t);
  }, [cron, timezone]);

  const save = async () => {
    setBusy(true);
    setError(null);
    const body = {
      agentId: targetAgent,
      name,
      prompt,
      cron,
      timezone,
      webhookUrl: webhookUrl || null,
      ...(webhookToken ? { webhookToken } : {}),
    };
    const res = await fetch(existing ? `/api/schedules/${existing.id}` : "/api/schedules", {
      method: existing ? "PATCH" : "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    setBusy(false);
    if (!res.ok) {
      setError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? "failed to save");
      return;
    }
    await useStore.getState().loadSchedules();
    onDone();
  };

  const field = "w-full rounded-lg border border-border bg-panel px-2.5 py-1.5 text-sm text-ink outline-none focus:border-accent-dim";
  const label = "block text-[0.72rem] uppercase tracking-wide text-ink-faint";

  return (
    <div className="space-y-3 rounded-xl border border-border bg-panel-2/40 p-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className={label}>Name</label>
          <input className={field} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <label className={label}>Agent</label>
          <select className={field} value={targetAgent} onChange={(e) => setTargetAgent(e.target.value)}>
            <option value="">Pick an agent…</option>
            {agents
              .filter((a) => !a.archived)
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
          </select>
        </div>
      </div>

      <div>
        <label className={label}>What should it do?</label>
        <textarea
          className={field + " min-h-[70px] resize-y"}
          placeholder="Search the web for today's top stories and publish a news-feed HTML artifact."
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
        />
      </div>

      <div>
        <label className={label}>When</label>
        {!useRaw ? (
          <div className="flex flex-wrap items-center gap-2">
            <select
              className={field + " w-auto"}
              value={preset}
              onChange={(e) => setPreset(Number(e.target.value))}
            >
              {PRESETS.map((p, i) => (
                <option key={p.label} value={i}>
                  {p.label}
                </option>
              ))}
            </select>
            {PRESETS[preset]!.needsDow && (
              <select className={field + " w-auto"} value={dow} onChange={(e) => setDow(e.target.value)}>
                {DOWS.map((d, i) => (
                  <option key={d} value={String(i)}>
                    {d}
                  </option>
                ))}
              </select>
            )}
            {PRESETS[preset]!.label !== "Every hour" && (
              <>
                <span className="text-sm text-ink-faint">at</span>
                <input
                  className={field + " w-14 text-center"}
                  value={hh}
                  onChange={(e) => setHh(e.target.value.replace(/\D/g, "").slice(0, 2))}
                />
                <span className="text-ink-faint">:</span>
              </>
            )}
            <input
              className={field + " w-14 text-center"}
              value={mm}
              onChange={(e) => setMm(e.target.value.replace(/\D/g, "").slice(0, 2))}
            />
            <input
              className={field + " w-auto flex-1 min-w-[10rem]"}
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              placeholder="IANA timezone"
            />
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            <input
              className={field + " flex-1 font-mono"}
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              placeholder="0 7 * * *"
            />
            <input
              className={field + " w-auto flex-1 min-w-[10rem]"}
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
            />
          </div>
        )}
        <button
          onClick={() => {
            if (!useRaw) setRaw(cron);
            setUseRaw(!useRaw);
          }}
          className="mt-1 text-[0.7rem] text-ink-faint underline hover:text-ink-dim"
        >
          {useRaw ? "use the simple picker" : "advanced: write a cron expression"}
        </button>
      </div>

      <div className="rounded-lg border border-border/60 bg-panel px-3 py-2 text-[0.72rem]">
        <span className="text-ink-faint">Next runs:</span>{" "}
        {preview.valid ? (
          preview.nextRuns.length ? (
            <span className="text-ink-dim">
              {preview.nextRuns.slice(0, 3).map((r) => when(r, timezone)).join(" · ")}
            </span>
          ) : (
            <span className="text-ink-faint">—</span>
          )
        ) : (
          <span className="text-danger">{preview.error}</span>
        )}
        <p className="mt-1 text-ink-faint">
          Runs happen while the server is up. A firing missed during a restart fires once when
          it comes back, rather than replaying every slot it missed.
        </p>
      </div>

      <details className="text-[0.75rem] text-ink-dim">
        <summary className="cursor-pointer text-ink-faint">Deliver the result to a webhook</summary>
        <div className="mt-2 space-y-2">
          <input
            className={field}
            placeholder="https://example.com/hook"
            value={webhookUrl}
            onChange={(e) => setWebhookUrl(e.target.value)}
          />
          <input
            className={field}
            type="password"
            placeholder={existing?.webhookTokenSet ? "bearer token (unchanged)" : "bearer token"}
            value={webhookToken}
            onChange={(e) => setWebhookToken(e.target.value)}
          />
        </div>
      </details>

      {error && <p className="text-[0.78rem] text-danger">{error}</p>}
      <div className="flex gap-2">
        <button
          disabled={busy || !targetAgent || !prompt.trim() || !preview.valid}
          onClick={() => void save()}
          className="rounded-lg border border-accent-dim/40 bg-accent-dim/20 px-3 py-1.5 text-sm text-accent hover:bg-accent-dim/30 disabled:opacity-40"
        >
          {busy ? "Saving…" : existing ? "Save" : "Create schedule"}
        </button>
        <button
          onClick={onDone}
          className="rounded-lg border border-border px-3 py-1.5 text-sm text-ink-dim hover:bg-panel-2"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/** Shared by the Schedules route and the agent's Schedules tab. */
export function ScheduleList({ agentId }: { agentId?: string }) {
  const schedules = useStore((s) => s.schedules);
  const agents = useStore((s) => s.agents);
  const loadSchedules = useStore((s) => s.loadSchedules);
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    void loadSchedules();
  }, [loadSchedules]);

  const rows = agentId ? schedules.filter((s) => s.agentId === agentId) : schedules;

  const runNow = async (s: Schedule) => {
    const res = await fetch(`/api/schedules/${s.id}/run`, { method: "POST" });
    const body = (await res.json().catch(() => ({}))) as { error?: string; threadId?: string };
    setNote(res.ok ? `Started "${s.name}".` : (body.error ?? "could not start"));
    await loadSchedules();
    if (body.threadId) navigate({ name: "thread", threadId: body.threadId });
  };

  const toggle = async (s: Schedule) => {
    await fetch(`/api/schedules/${s.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: !s.enabled }),
    });
    await loadSchedules();
  };

  const remove = async (s: Schedule) => {
    await fetch(`/api/schedules/${s.id}`, { method: "DELETE" });
    await loadSchedules();
  };

  return (
    <div className="space-y-3 px-6 py-4">
      {note && <p className="text-[0.78rem] text-ink-dim">{note}</p>}

      {editing === "new" ? (
        <ScheduleEditor agentId={agentId} onDone={() => setEditing(null)} />
      ) : (
        <button
          onClick={() => setEditing("new")}
          className="rounded-lg border border-accent-dim/40 bg-accent-dim/20 px-3 py-1.5 text-sm text-accent hover:bg-accent-dim/30"
        >
          + New schedule
        </button>
      )}

      {rows.map((s) =>
        editing === s.id ? (
          <ScheduleEditor key={s.id} existing={s} onDone={() => setEditing(null)} />
        ) : (
          <div key={s.id} className="rounded-xl border border-border bg-panel-2/30 p-3.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className={"text-sm " + (s.enabled ? "text-ink" : "text-ink-faint line-through")}>
                {s.name}
              </span>
              {!agentId && (
                <span className="text-[0.72rem] text-ink-faint">
                  {agents.find((a) => a.id === s.agentId)?.name ?? "unknown agent"}
                </span>
              )}
              <code className="rounded bg-panel px-1.5 py-px font-mono text-[0.68rem] text-ink-dim">
                {s.cron} · {s.timezone}
              </code>
              {s.lastStatus && (
                <span
                  className={"rounded-full border px-2 py-px text-[0.66rem] " + (STATUS_CLS[s.lastStatus] ?? "")}
                  title={s.lastError ?? undefined}
                >
                  {s.lastStatus}
                </span>
              )}
              <div className="ml-auto flex gap-1">
                <button
                  onClick={() => void runNow(s)}
                  className="rounded border border-border px-2 py-0.5 text-[0.72rem] text-ink-dim hover:bg-panel-2 hover:text-ink"
                >
                  Run now
                </button>
                <button
                  onClick={() => void toggle(s)}
                  className="rounded border border-border px-2 py-0.5 text-[0.72rem] text-ink-dim hover:bg-panel-2 hover:text-ink"
                >
                  {s.enabled ? "Pause" : "Resume"}
                </button>
                <button
                  onClick={() => setEditing(s.id)}
                  className="rounded border border-border px-2 py-0.5 text-[0.72rem] text-ink-dim hover:bg-panel-2 hover:text-ink"
                >
                  Edit
                </button>
                <button
                  onClick={() => void remove(s)}
                  className="rounded border border-border px-2 py-0.5 text-[0.72rem] text-ink-faint hover:bg-panel-2 hover:text-danger"
                >
                  ×
                </button>
              </div>
            </div>
            <p className="mt-1.5 truncate text-[0.78rem] text-ink-faint">{s.prompt}</p>
            <p className="mt-1 text-[0.7rem] text-ink-faint">
              Next: {s.enabled ? when(s.nextRunAt, s.timezone) : "paused"}
              {s.lastRunAt && ` · Last: ${when(s.lastRunAt, s.timezone)}`}
              {s.lastRunThreadId && (
                <>
                  {" · "}
                  <button
                    onClick={() => navigate({ name: "thread", threadId: s.lastRunThreadId! })}
                    className="underline hover:text-ink-dim"
                  >
                    open last run
                  </button>
                </>
              )}
            </p>
            {s.lastError && <p className="mt-1 text-[0.7rem] text-danger">{s.lastError}</p>}
          </div>
        ),
      )}

      {!rows.length && editing !== "new" && (
        <p className="text-sm text-ink-faint">
          No schedules yet. A schedule runs an agent on a timer — "every morning at 7, publish a
          news brief" — and each firing becomes its own thread.
        </p>
      )}
    </div>
  );
}

export function SchedulesView() {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-center gap-3 border-b border-border bg-panel px-6 py-3">
        <h2 className="font-medium text-ink">Schedules</h2>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <ScheduleList />
      </div>
    </div>
  );
}
