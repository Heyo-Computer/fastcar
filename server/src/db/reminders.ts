/**
 * Reminders table access, including the claim that makes the sweep safe.
 */
import { getPool } from "./pool.js";

export type ReminderStatus = "pending" | "firing" | "fired" | "cancelled" | "error";

interface ReminderRow {
  id: string;
  thread_id: string;
  message: string;
  due_at: Date;
  status: ReminderStatus;
  attempts: number;
  fired_at: Date | null;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface ReminderRecord {
  id: string;
  threadId: string;
  message: string;
  dueAt: string;
  status: ReminderStatus;
  attempts: number;
  firedAt: string | null;
  lastError: string | null;
  createdAt: string;
}

function toRecord(r: ReminderRow): ReminderRecord {
  return {
    id: r.id,
    threadId: r.thread_id,
    message: r.message,
    dueAt: r.due_at.toISOString(),
    status: r.status,
    attempts: r.attempts,
    firedAt: r.fired_at?.toISOString() ?? null,
    lastError: r.last_error,
    createdAt: r.created_at.toISOString(),
  };
}

export async function createReminder(threadId: string, message: string, dueAt: Date): Promise<ReminderRecord> {
  const { rows } = await getPool().query<ReminderRow>(
    "INSERT INTO reminders (thread_id, message, due_at) VALUES ($1, $2, $3) RETURNING *",
    [threadId, message, dueAt],
  );
  return toRecord(rows[0]!);
}

export async function getReminder(id: string): Promise<ReminderRecord | null> {
  const { rows } = await getPool().query<ReminderRow>("SELECT * FROM reminders WHERE id = $1", [id]);
  return rows[0] ? toRecord(rows[0]) : null;
}

/** A thread's reminders, soonest first; pending only unless `all`. */
export async function listReminders(threadId: string, all = false): Promise<ReminderRecord[]> {
  const { rows } = await getPool().query<ReminderRow>(
    `SELECT * FROM reminders
     WHERE thread_id = $1 AND ($2 OR status = 'pending')
     ORDER BY due_at ASC
     LIMIT 100`,
    [threadId, all],
  );
  return rows.map(toRecord);
}

/** Cancel a pending reminder. Scoped to the thread so one thread cannot cancel another's. */
export async function cancelReminder(id: string, threadId: string): Promise<boolean> {
  const { rowCount } = await getPool().query(
    `UPDATE reminders SET status = 'cancelled', updated_at = now()
     WHERE id = $1 AND thread_id = $2 AND status = 'pending'`,
    [id, threadId],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Atomically claim up to `limit` due reminders. SKIP LOCKED means two
 * overlapping sweeps (or two processes) split the rows rather than both
 * firing the same one.
 */
export async function claimDueReminders(limit = 20): Promise<ReminderRecord[]> {
  const { rows } = await getPool().query<ReminderRow>(
    `UPDATE reminders SET status = 'firing', attempts = attempts + 1, updated_at = now()
     WHERE id IN (
       SELECT id FROM reminders
       WHERE status = 'pending' AND due_at <= now()
       ORDER BY due_at ASC
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING *`,
    [limit],
  );
  return rows.map(toRecord);
}

export async function markFired(id: string): Promise<void> {
  await getPool().query(
    `UPDATE reminders SET status = 'fired', fired_at = now(), last_error = NULL, updated_at = now()
     WHERE id = $1`,
    [id],
  );
}

/** Hand a claimed reminder back to the next sweep (the thread was busy). */
export async function releaseReminder(id: string, reason: string): Promise<void> {
  await getPool().query(
    `UPDATE reminders SET status = 'pending', last_error = $2, updated_at = now() WHERE id = $1`,
    [id, reason],
  );
}

export async function markError(id: string, error: string): Promise<void> {
  await getPool().query(
    `UPDATE reminders SET status = 'error', last_error = $2, updated_at = now() WHERE id = $1`,
    [id, error],
  );
}

/** Boot recovery: a crash mid-delivery leaves rows 'firing' forever. */
export async function resetFiringReminders(): Promise<number> {
  const { rowCount } = await getPool().query(
    `UPDATE reminders SET status = 'pending', updated_at = now() WHERE status = 'firing'`,
  );
  return rowCount ?? 0;
}
