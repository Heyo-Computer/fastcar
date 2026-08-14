import type { AgentName, PersistedEvent } from "@fastcar/shared";
import { getPool } from "./pool.js";

export interface EventInsert {
  threadId: string;
  seq: number;
  agent: AgentName;
  taskId?: string | null;
  kind: PersistedEvent["kind"];
  payload: Record<string, unknown>;
}

export async function insertEvents(events: EventInsert[]): Promise<void> {
  if (!events.length) return;
  const pool = getPool();
  const values: unknown[] = [];
  const tuples = events.map((e) => {
    values.push(e.threadId, e.seq, e.agent, e.taskId ?? null, e.kind, JSON.stringify(e.payload));
    const n = values.length;
    return `($${n - 5}, $${n - 4}, $${n - 3}, $${n - 2}, $${n - 1}, $${n})`;
  });
  await pool.query(
    `INSERT INTO events (thread_id, seq, agent, task_id, kind, payload)
     VALUES ${tuples.join(", ")}
     ON CONFLICT (thread_id, seq) DO NOTHING`,
    values,
  );
}

export async function listEvents(threadId: string): Promise<PersistedEvent[]> {
  const { rows } = await getPool().query(
    `SELECT seq, agent, task_id, kind, payload, created_at
     FROM events WHERE thread_id = $1 ORDER BY seq ASC`,
    [threadId],
  );
  return rows.map((r) => ({
    seq: r.seq,
    agent: r.agent,
    taskId: r.task_id,
    kind: r.kind,
    payload: r.payload,
    createdAt: r.created_at.toISOString(),
  }));
}

export async function maxSeq(threadId: string): Promise<number> {
  const { rows } = await getPool().query(
    "SELECT COALESCE(MAX(seq), 0) AS max FROM events WHERE thread_id = $1",
    [threadId],
  );
  return Number(rows[0]?.max ?? 0);
}
