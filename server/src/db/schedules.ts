/**
 * Schedules table access, including the claim that makes the tick safe.
 */
import type { ScheduleStatus, ThreadMode } from "@fastcar/shared";
import { getPool } from "./pool.js";

interface ScheduleRow {
  id: string;
  agent_id: string;
  name: string;
  prompt: string;
  cron: string;
  timezone: string;
  mode: ThreadMode;
  enabled: boolean;
  catch_up: boolean;
  webhook_url: string | null;
  next_run_at: Date | null;
  last_run_at: Date | null;
  last_run_thread_id: string | null;
  last_status: ScheduleStatus | null;
  last_error: string | null;
  owner_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface ScheduleRecord {
  id: string;
  agentId: string;
  name: string;
  prompt: string;
  cron: string;
  timezone: string;
  mode: ThreadMode;
  enabled: boolean;
  catchUp: boolean;
  webhookUrl: string | null;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastRunThreadId: string | null;
  lastStatus: ScheduleStatus | null;
  lastError: string | null;
  ownerId: string | null;
  createdAt: string;
  updatedAt: string;
}

function toRecord(r: ScheduleRow): ScheduleRecord {
  return {
    id: r.id,
    agentId: r.agent_id,
    name: r.name,
    prompt: r.prompt,
    cron: r.cron,
    timezone: r.timezone,
    mode: r.mode,
    enabled: r.enabled,
    catchUp: r.catch_up,
    webhookUrl: r.webhook_url,
    nextRunAt: r.next_run_at?.toISOString() ?? null,
    lastRunAt: r.last_run_at?.toISOString() ?? null,
    lastRunThreadId: r.last_run_thread_id,
    lastStatus: r.last_status,
    lastError: r.last_error,
    ownerId: r.owner_id,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

export async function listSchedules(agentId?: string): Promise<ScheduleRecord[]> {
  const { rows } = await getPool().query<ScheduleRow>(
    `SELECT * FROM schedules WHERE ($1::uuid IS NULL OR agent_id = $1)
     ORDER BY enabled DESC, next_run_at ASC NULLS LAST, name ASC`,
    [agentId ?? null],
  );
  return rows.map(toRecord);
}

export async function getSchedule(id: string): Promise<ScheduleRecord | null> {
  const { rows } = await getPool().query<ScheduleRow>("SELECT * FROM schedules WHERE id = $1", [id]);
  return rows[0] ? toRecord(rows[0]) : null;
}

export interface NewSchedule {
  agentId: string;
  name: string;
  prompt: string;
  cron: string;
  timezone: string;
  mode: ThreadMode;
  enabled: boolean;
  catchUp: boolean;
  webhookUrl: string | null;
  nextRunAt: Date | null;
  ownerId: string | null;
}

export async function createSchedule(s: NewSchedule): Promise<ScheduleRecord> {
  const { rows } = await getPool().query<ScheduleRow>(
    `INSERT INTO schedules
       (agent_id, name, prompt, cron, timezone, mode, enabled, catch_up, webhook_url, next_run_at, owner_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [s.agentId, s.name, s.prompt, s.cron, s.timezone, s.mode, s.enabled, s.catchUp,
     s.webhookUrl, s.nextRunAt, s.ownerId],
  );
  return toRecord(rows[0]!);
}

export type SchedulePatch = Partial<{
  name: string;
  prompt: string;
  cron: string;
  timezone: string;
  mode: ThreadMode;
  enabled: boolean;
  catchUp: boolean;
  webhookUrl: string | null;
  nextRunAt: Date | null;
  lastRunAt: Date | null;
  lastRunThreadId: string | null;
  lastStatus: ScheduleStatus | null;
  lastError: string | null;
}>;

export async function updateSchedule(id: string, patch: SchedulePatch): Promise<ScheduleRecord | null> {
  const sets: string[] = ["updated_at = now()"];
  const values: unknown[] = [];
  const col = (name: string, value: unknown) => {
    values.push(value);
    sets.push(`${name} = $${values.length}`);
  };
  if (patch.name !== undefined) col("name", patch.name);
  if (patch.prompt !== undefined) col("prompt", patch.prompt);
  if (patch.cron !== undefined) col("cron", patch.cron);
  if (patch.timezone !== undefined) col("timezone", patch.timezone);
  if (patch.mode !== undefined) col("mode", patch.mode);
  if (patch.enabled !== undefined) col("enabled", patch.enabled);
  if (patch.catchUp !== undefined) col("catch_up", patch.catchUp);
  if (patch.webhookUrl !== undefined) col("webhook_url", patch.webhookUrl);
  if (patch.nextRunAt !== undefined) col("next_run_at", patch.nextRunAt);
  if (patch.lastRunAt !== undefined) col("last_run_at", patch.lastRunAt);
  if (patch.lastRunThreadId !== undefined) col("last_run_thread_id", patch.lastRunThreadId);
  if (patch.lastStatus !== undefined) col("last_status", patch.lastStatus);
  if (patch.lastError !== undefined) col("last_error", patch.lastError);
  values.push(id);
  const { rows } = await getPool().query<ScheduleRow>(
    `UPDATE schedules SET ${sets.join(", ")} WHERE id = $${values.length} RETURNING *`,
    values,
  );
  return rows[0] ? toRecord(rows[0]) : null;
}

export async function deleteSchedule(id: string): Promise<boolean> {
  const { rowCount } = await getPool().query("DELETE FROM schedules WHERE id = $1", [id]);
  return (rowCount ?? 0) > 0;
}

/** Ids of enabled schedules whose time has come. */
export async function dueSchedules(limit = 20): Promise<string[]> {
  const { rows } = await getPool().query<{ id: string }>(
    `SELECT id FROM schedules
     WHERE enabled AND next_run_at IS NOT NULL AND next_run_at <= now()
       AND (last_status IS DISTINCT FROM 'running' OR last_run_at < now() - interval '30 minutes')
     ORDER BY next_run_at LIMIT $1`,
    [limit],
  );
  return rows.map((r) => r.id);
}

/**
 * Claim a schedule for this process, as one conditional UPDATE.
 *
 * Zero rows back means someone else claimed it, or its previous run is still
 * going — either way, skip. Doing this as a CAS rather than an advisory lock
 * is deliberate: `pg.Pool` hands out an arbitrary connection per query and does
 * not pin, so a session-scoped `pg_try_advisory_lock` could unlock on a
 * different backend than it locked. This gives overlap prevention, duplicate
 * -fire prevention and cross-process safety in one statement.
 *
 * `force` skips only the due check, for a manual "run now".
 */
export async function claimSchedule(
  id: string,
  nextRunAt: Date | null,
  force = false,
): Promise<ScheduleRecord | null> {
  const dueClause = force ? "" : "AND next_run_at IS NOT NULL AND next_run_at <= now()";
  const { rows } = await getPool().query<ScheduleRow>(
    `UPDATE schedules
     SET last_status = 'running', last_run_at = now(), next_run_at = $2, updated_at = now()
     WHERE id = $1 AND enabled ${dueClause}
       AND (last_status IS DISTINCT FROM 'running' OR last_run_at < now() - interval '30 minutes')
     RETURNING *`,
    [id, nextRunAt],
  );
  return rows[0] ? toRecord(rows[0]) : null;
}

/**
 * Boot recovery. A crash mid-run leaves last_status = 'running', which the
 * claim treats as "still going" and would wedge the schedule for 30 minutes
 * on every tick. Mirrors resetTransientStatuses() for threads — which
 * deliberately does not cover this, since it knows nothing about schedules.
 */
export async function resetRunningSchedules(): Promise<number> {
  const { rowCount } = await getPool().query(
    `UPDATE schedules
     SET last_status = 'error', last_error = 'server restarted during run'
     WHERE last_status = 'running'`,
  );
  return rowCount ?? 0;
}

/** Enabled schedules with no next_run_at yet (fresh boot, or a cron edit). */
export async function schedulesNeedingNextRun(): Promise<ScheduleRecord[]> {
  const { rows } = await getPool().query<ScheduleRow>(
    "SELECT * FROM schedules WHERE enabled AND next_run_at IS NULL",
  );
  return rows.map(toRecord);
}
