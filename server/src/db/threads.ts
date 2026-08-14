import type { PendingInteraction, ThreadMeta, ThreadMode, ThreadStatus } from "@fastcar/shared";
import { getPool } from "./pool.js";

interface ThreadRow {
  id: string;
  title: string;
  mode: ThreadMode;
  status: ThreadStatus;
  pi_session_file: string | null;
  pending_json: PendingInteraction | null;
  archived: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface ThreadRecord extends ThreadMeta {
  piSessionFile: string | null;
  pending: PendingInteraction | null;
}

function toRecord(row: ThreadRow): ThreadRecord {
  return {
    id: row.id,
    title: row.title,
    mode: row.mode,
    status: row.status,
    archived: row.archived,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    piSessionFile: row.pi_session_file,
    pending: row.pending_json,
  };
}

export function toMeta(rec: ThreadRecord): ThreadMeta {
  const { piSessionFile: _f, pending: _p, ...meta } = rec;
  return meta;
}

export async function createThread(mode: ThreadMode): Promise<ThreadRecord> {
  const { rows } = await getPool().query<ThreadRow>(
    "INSERT INTO threads (mode) VALUES ($1) RETURNING *",
    [mode],
  );
  return toRecord(rows[0]!);
}

export async function getThread(id: string): Promise<ThreadRecord | null> {
  const { rows } = await getPool().query<ThreadRow>("SELECT * FROM threads WHERE id = $1", [id]);
  return rows[0] ? toRecord(rows[0]) : null;
}

export async function listThreads(): Promise<ThreadRecord[]> {
  const { rows } = await getPool().query<ThreadRow>(
    "SELECT * FROM threads WHERE NOT archived ORDER BY updated_at DESC LIMIT 200",
  );
  return rows.map(toRecord);
}

export async function updateThread(
  id: string,
  patch: Partial<{
    title: string;
    mode: ThreadMode;
    status: ThreadStatus;
    piSessionFile: string | null;
    pending: PendingInteraction | null;
    archived: boolean;
  }>,
): Promise<ThreadRecord | null> {
  const sets: string[] = ["updated_at = now()"];
  const values: unknown[] = [];
  const col = (name: string, value: unknown) => {
    values.push(value);
    sets.push(`${name} = $${values.length}`);
  };
  if (patch.title !== undefined) col("title", patch.title);
  if (patch.mode !== undefined) col("mode", patch.mode);
  if (patch.status !== undefined) col("status", patch.status);
  if (patch.piSessionFile !== undefined) col("pi_session_file", patch.piSessionFile);
  if (patch.pending !== undefined) col("pending_json", JSON.stringify(patch.pending));
  if (patch.archived !== undefined) col("archived", patch.archived);
  values.push(id);
  const { rows } = await getPool().query<ThreadRow>(
    `UPDATE threads SET ${sets.join(", ")} WHERE id = $${values.length} RETURNING *`,
    values,
  );
  return rows[0] ? toRecord(rows[0]) : null;
}

/** Reset threads left in transient states by a previous server process. */
export async function resetTransientStatuses(): Promise<void> {
  await getPool().query(
    `UPDATE threads SET status = 'idle', pending_json = NULL
     WHERE status IN ('running','awaiting_input')`,
  );
}
