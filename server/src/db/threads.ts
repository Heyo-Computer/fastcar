import type {
  PendingInteraction,
  PromptThreadConfig,
  ThreadMeta,
  ThreadMode,
  ThreadSource,
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
  agent_id: string | null;
  last_message_at: Date | null;
  last_message_preview: string | null;
  last_message_agent: string | null;
  last_error: string | null;
  read_at: Date | null;
  source: ThreadSource;
  schedule_id: string | null;
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
  /** Owning agent. Null on threads created before agents existed, and on
   *  createThread() calls that name none; both resolve to the builtin. */
  agentId: string | null;
  /** Inbox projection — see 006_inbox.sql. */
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  lastMessageAgent: string | null;
  lastError: string | null;
  readAt: string | null;
  source: ThreadSource;
  /** The schedule whose firing created this thread, when there was one. */
  scheduleId: string | null;
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
    agentId: row.agent_id,
    lastMessageAt: row.last_message_at?.toISOString() ?? null,
    lastMessagePreview: row.last_message_preview,
    lastMessageAgent: row.last_message_agent,
    lastError: row.last_error,
    readAt: row.read_at?.toISOString() ?? null,
    source: row.source,
    scheduleId: row.schedule_id,
  };
}

export function toMeta(rec: ThreadRecord): ThreadMeta {
  const {
    piSessionFile: _f, pending: _p, promptConfig: _c, ownerId: _o,
    lastMessageAgent: _a, lastError: _e, readAt: _r, ...rest
  } = rec;
  // `unread` is derived, never stored: a reply landing after you read re-marks
  // the thread without anything having to invalidate a flag.
  return { ...rest, unread: isUnread(rec) };
}

/** The one definition of unread. Mirrors the SQL in inboxCounts(). */
export function isUnread(rec: Pick<ThreadRecord, "lastMessageAt" | "readAt">): boolean {
  if (!rec.lastMessageAt) return false;
  return !rec.readAt || rec.readAt < rec.lastMessageAt;
}

export async function createThread(
  mode: ThreadMode,
  threadType: ThreadType = "chat",
  ownerId: string | null = null,
  agentId: string | null = null,
  opts: { source?: ThreadSource; title?: string; scheduleId?: string | null } = {},
): Promise<ThreadRecord> {
  const { rows } = await getPool().query<ThreadRow>(
    `INSERT INTO threads (mode, thread_type, owner_id, agent_id, source, title)
     VALUES ($1, $2, $3, $4, $5, COALESCE($6, 'New thread')) RETURNING *`,
    [mode, threadType, ownerId, agentId, opts.source ?? "chat", opts.title ?? null],
  );
  return toRecord(rows[0]!);
}

export async function getThread(id: string): Promise<ThreadRecord | null> {
  const { rows } = await getPool().query<ThreadRow>("SELECT * FROM threads WHERE id = $1", [id]);
  return rows[0] ? toRecord(rows[0]) : null;
}

export async function listThreads(opts: { agentId?: string; limit?: number } = {}): Promise<ThreadRecord[]> {
  const { rows } = await getPool().query<ThreadRow>(
    `SELECT * FROM threads
     WHERE NOT archived AND ($1::uuid IS NULL OR agent_id = $1)
     ORDER BY updated_at DESC LIMIT $2`,
    [opts.agentId ?? null, opts.limit ?? 200],
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
    agentId: string | null;
    lastMessageAt: Date | null;
    lastMessagePreview: string | null;
    lastMessageAgent: string | null;
    lastError: string | null;
    readAt: Date | null;
    source: ThreadSource;
    scheduleId: string | null;
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
  if (patch.agentId !== undefined) col("agent_id", patch.agentId);
  if (patch.lastMessageAt !== undefined) col("last_message_at", patch.lastMessageAt);
  if (patch.lastMessagePreview !== undefined) col("last_message_preview", patch.lastMessagePreview);
  if (patch.lastMessageAgent !== undefined) col("last_message_agent", patch.lastMessageAgent);
  if (patch.lastError !== undefined) col("last_error", patch.lastError);
  if (patch.readAt !== undefined) col("read_at", patch.readAt);
  if (patch.source !== undefined) col("source", patch.source);
  if (patch.scheduleId !== undefined) col("schedule_id", patch.scheduleId);
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
