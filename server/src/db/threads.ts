import type {
  PendingInteraction,
  PromptThreadConfig,
  ThreadMeta,
  ThreadMode,
  ThreadStatus,
  ThreadType,
} from "@fastcar/shared";
import { getPool } from "./pool.js";

interface ThreadRow {
  id: string;
  title: string;
  mode: ThreadMode;
  status: ThreadStatus;
  thread_type: ThreadType;
  pi_session_file: string | null;
  pending_json: PendingInteraction | null;
  prompt_config_json: PromptThreadConfig | null;
  owner_id: string | null;
  archived: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface ThreadRecord extends ThreadMeta {
  piSessionFile: string | null;
  pending: PendingInteraction | null;
  /** Present only for prompt threads. */
  promptConfig: PromptThreadConfig | null;
  ownerId: string | null;
}

function toRecord(row: ThreadRow): ThreadRecord {
  return {
    id: row.id,
    title: row.title,
    mode: row.mode,
    status: row.status,
    threadType: row.thread_type,
    archived: row.archived,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    piSessionFile: row.pi_session_file,
    pending: row.pending_json,
    promptConfig: row.prompt_config_json,
    ownerId: row.owner_id,
  };
}

export function toMeta(rec: ThreadRecord): ThreadMeta {
  const { piSessionFile: _f, pending: _p, promptConfig: _c, ownerId: _o, ...meta } = rec;
  return meta;
}

export async function createThread(
  mode: ThreadMode,
  threadType: ThreadType = "chat",
  ownerId: string | null = null,
): Promise<ThreadRecord> {
  const { rows } = await getPool().query<ThreadRow>(
    "INSERT INTO threads (mode, thread_type, owner_id) VALUES ($1, $2, $3) RETURNING *",
    [mode, threadType, ownerId],
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
    promptConfig: PromptThreadConfig | null;
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
  if (patch.promptConfig !== undefined)
    col("prompt_config_json", JSON.stringify(patch.promptConfig));
  if (patch.archived !== undefined) col("archived", patch.archived);
  values.push(id);
  const { rows } = await getPool().query<ThreadRow>(
    `UPDATE threads SET ${sets.join(", ")} WHERE id = $${values.length} RETURNING *`,
    values,
  );
  return rows[0] ? toRecord(rows[0]) : null;
}

/** Hard-delete a thread; its events cascade (see 001_init.sql). */
export async function deleteThread(id: string): Promise<boolean> {
  const { rowCount } = await getPool().query("DELETE FROM threads WHERE id = $1", [id]);
  return (rowCount ?? 0) > 0;
}

/** Reset threads left in transient states by a previous server process. */
export async function resetTransientStatuses(): Promise<void> {
  await getPool().query(
    `UPDATE threads SET status = 'idle', pending_json = NULL
     WHERE status IN ('running','awaiting_input')`,
  );
}
