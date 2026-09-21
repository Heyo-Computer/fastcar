/**
 * Cron-triggered agent runs.
 *
 * The loop is DB-driven rather than timer-driven: `next_run_at` is persisted,
 * so a schedule survives the process restarting (which it does on every
 * rollout) and a firing missed during downtime is simply due at the next tick.
 * croner is used purely as a calculator — it owns no timers here.
 */
import { EventEmitter } from "node:events";
import { Cron } from "croner";
import type { Schedule, ScheduleDraft } from "@fastcar/shared";
import * as schedulesDb from "../db/schedules.js";
import type { ScheduleRecord } from "../db/schedules.js";
import type { ThreadManager } from "../threads/manager.js";
import type { AgentService } from "./agents.js";
import { validateWebhookUrl } from "./webhook.js";
import type { WebhookTokenStore } from "./webhookTokens.js";

/** Emits "changed" after any create/update/delete/fire. */
export const scheduleEvents = new EventEmitter();

const TICK_MS = 30_000;
/** A catch_up schedule replays at most this many missed slots. */
const MAX_CATCH_UP = 5;

export class ScheduleValidationError extends Error {}

/** Valid IANA zone? Node ships the list, so this needs no dependency. */
function isValidTimezone(tz: string): boolean {
  try {
    return (Intl as unknown as { supportedValuesOf(k: string): string[] })
      .supportedValuesOf("timeZone")
      .includes(tz);
  } catch {
    // Older runtimes without supportedValuesOf: fall back to a format attempt.
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Next firing strictly after `after`. Returns null for an expression that will
 * never fire again.
 */
export function nextRun(cron: string, timezone: string, after: Date = new Date()): Date | null {
  return new Cron(cron, { timezone }).nextRun(after);
}

/** The next few firings, for the form's "what does this actually mean" preview. */
export function previewRuns(cron: string, timezone: string, count = 3): string[] {
  const c = new Cron(cron, { timezone });
  return (c.nextRuns(count) ?? []).map((d) => d.toISOString());
}

export function validateCron(cron: string, timezone: string): { ok: true } | { ok: false; error: string } {
  if (!isValidTimezone(timezone)) return { ok: false, error: `unknown timezone: ${timezone}` };
  try {
    const c = new Cron(cron, { timezone });
    if (!c.nextRun()) return { ok: false, error: "this expression will never fire again" };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(
    private readonly manager: ThreadManager,
    private readonly agents: AgentService,
    private readonly tokens: WebhookTokenStore,
  ) {}

  async start(): Promise<void> {
    // A crash mid-run leaves last_status='running', which the claim reads as
    // "still going" and would wedge the schedule on every tick.
    const unwedged = await schedulesDb.resetRunningSchedules();
    if (unwedged) console.log(`scheduler: reset ${unwedged} schedule(s) left running by a previous process`);

    // Fresh boot, or a row whose cron was edited without a recompute.
    for (const s of await schedulesDb.schedulesNeedingNextRun()) {
      await schedulesDb.updateSchedule(s.id, { nextRunAt: nextRun(s.cron, s.timezone) });
    }

    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref?.();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One pass over due schedules. Overlapping ticks are skipped. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const id of await schedulesDb.dueSchedules()) {
        await this.fire(id).catch((err) => console.error(`schedule ${id} failed:`, err));
      }
    } catch (err) {
      console.error("scheduler tick failed:", err);
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Claim and run one schedule.
   *
   * `catch_up = false` (the default) fires once and re-bases to the next future
   * slot, so a week of downtime produces one fresh brief rather than seven
   * stale ones. `catch_up = true` still fires once per tick, but advances
   * `next_run_at` one missed slot at a time (capped) so the backlog drains.
   */
  private async fire(id: string, force = false): Promise<{ threadId: string } | { skipped: string }> {
    const before = await schedulesDb.getSchedule(id);
    if (!before) return { skipped: "no such schedule" };

    const from = new Date();
    let next = nextRun(before.cron, before.timezone, from);
    if (before.catchUp && before.nextRunAt) {
      // Advance from the missed slot rather than from now, capped so a long
      // outage cannot produce an unbounded run of firings.
      let cursor = new Date(before.nextRunAt);
      for (let i = 0; i < MAX_CATCH_UP; i++) {
        const step = nextRun(before.cron, before.timezone, cursor);
        if (!step || step > from) break;
        cursor = step;
      }
      next = nextRun(before.cron, before.timezone, cursor > from ? cursor : from);
    }

    const claimed = await schedulesDb.claimSchedule(id, next, force);
    if (!claimed) {
      return { skipped: "already running or not due" };
    }

    let threadId: string;
    try {
      threadId = await this.manager.runSchedule(claimed);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await schedulesDb.updateSchedule(id, { lastStatus: "error", lastError: message });
      scheduleEvents.emit("changed");
      throw err;
    }
    scheduleEvents.emit("changed");
    return { threadId };
  }

  /** Manual "run now": the same path, with only the due check bypassed. */
  async runNow(id: string): Promise<{ threadId: string } | { skipped: string }> {
    return this.fire(id, true);
  }

  // ------------------------------------------------------------------ CRUD

  private async validate(d: Partial<ScheduleDraft>, existing?: ScheduleRecord): Promise<void> {
    const cron = d.cron ?? existing?.cron;
    const tz = d.timezone ?? existing?.timezone ?? "UTC";
    if (cron !== undefined) {
      const v = validateCron(cron, tz);
      if (!v.ok) throw new ScheduleValidationError(v.error);
    }
    if (d.agentId !== undefined && !(await this.agents.get(d.agentId))) {
      throw new ScheduleValidationError(`no such agent: ${d.agentId}`);
    }
    if (d.name !== undefined && !d.name.trim()) {
      throw new ScheduleValidationError("name cannot be empty");
    }
    if (d.prompt !== undefined && !d.prompt.trim()) {
      throw new ScheduleValidationError("prompt cannot be empty");
    }
    if (d.webhookUrl) {
      const v = validateWebhookUrl(d.webhookUrl);
      if (!v.ok) throw new ScheduleValidationError(`webhook URL invalid: ${v.reason}`);
    }
  }

  async create(draft: ScheduleDraft, ownerId: string | null = null): Promise<ScheduleRecord> {
    await this.validate(draft);
    const timezone = draft.timezone ?? "UTC";
    const enabled = draft.enabled ?? true;
    const rec = await schedulesDb.createSchedule({
      agentId: draft.agentId,
      name: draft.name.trim(),
      prompt: draft.prompt,
      cron: draft.cron,
      timezone,
      mode: draft.mode ?? "act",
      enabled,
      catchUp: draft.catchUp ?? false,
      webhookUrl: draft.webhookUrl ?? null,
      nextRunAt: enabled ? nextRun(draft.cron, timezone) : null,
      ownerId,
    });
    if (draft.webhookToken) this.tokens.setScheduleToken(rec.id, draft.webhookToken);
    scheduleEvents.emit("changed");
    return rec;
  }

  async update(id: string, patch: Partial<ScheduleDraft>): Promise<ScheduleRecord> {
    const existing = await schedulesDb.getSchedule(id);
    if (!existing) throw new ScheduleValidationError(`no such schedule: ${id}`);
    await this.validate(patch, existing);

    const cron = patch.cron ?? existing.cron;
    const timezone = patch.timezone ?? existing.timezone;
    const enabled = patch.enabled ?? existing.enabled;
    // Any of these three changes what "next" means, so recompute rather than
    // letting a stale next_run_at fire on the old schedule.
    const recompute =
      patch.cron !== undefined || patch.timezone !== undefined || patch.enabled !== undefined;

    const rec = await schedulesDb.updateSchedule(id, {
      ...patch,
      webhookUrl: patch.webhookUrl,
      ...(recompute ? { nextRunAt: enabled ? nextRun(cron, timezone) : null } : {}),
    });
    if (!rec) throw new ScheduleValidationError(`no such schedule: ${id}`);
    if (patch.webhookToken) this.tokens.setScheduleToken(id, patch.webhookToken);
    scheduleEvents.emit("changed");
    return rec;
  }

  async remove(id: string): Promise<void> {
    await schedulesDb.deleteSchedule(id);
    this.tokens.deleteScheduleToken(id);
    scheduleEvents.emit("changed");
  }

  async list(agentId?: string): Promise<Schedule[]> {
    const rows = await schedulesDb.listSchedules(agentId);
    return rows.map((r) => this.toWire(r));
  }

  toWire(r: ScheduleRecord): Schedule {
    return {
      id: r.id,
      agentId: r.agentId,
      name: r.name,
      prompt: r.prompt,
      cron: r.cron,
      timezone: r.timezone,
      mode: r.mode,
      enabled: r.enabled,
      catchUp: r.catchUp,
      webhookUrl: r.webhookUrl,
      webhookTokenSet: Boolean(this.tokens.getScheduleToken(r.id)),
      nextRunAt: r.nextRunAt,
      lastRunAt: r.lastRunAt,
      lastRunThreadId: r.lastRunThreadId,
      lastStatus: r.lastStatus,
      lastError: r.lastError,
      nextRuns: r.enabled ? previewRuns(r.cron, r.timezone, 3) : [],
    };
  }
}
