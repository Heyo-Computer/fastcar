/**
 * Inbox queries.
 *
 * The inbox is a projection of `threads` (see 006_inbox.sql), so there is no
 * table of its own to keep in step — these are two reads over columns the
 * thread write path already maintains.
 */
import type { InboxFilter, InboxItem } from "@fastcar/shared";
import { getPool } from "./pool.js";

interface InboxRow {
  id: string;
  title: string;
  status: InboxItem["status"];
  mode: InboxItem["mode"];
  source: InboxItem["source"];
  schedule_id: string | null;
  agent_id: string | null;
  agent_slug: string | null;
  agent_name: string | null;
  agent_avatar: string | null;
  last_message_preview: string | null;
  last_message_at: Date | null;
  read_at: Date | null;
  last_error: string | null;
  artifacts: Array<{ id: string; name: string }> | null;
}

/**
 * The one definition of unread, in SQL. Kept beside isUnread() in db/threads.ts
 * — a reply landing after you read re-marks the thread, with nothing to
 * invalidate.
 */
const UNREAD_SQL = `t.last_message_at IS NOT NULL
  AND (t.read_at IS NULL OR t.read_at < t.last_message_at)`;

/** Dismissed with no reply since. Mirrors isInboxHidden() in db/threads.ts. */
const DISMISSED_SQL = `t.inbox_dismissed_at IS NOT NULL
  AND (t.last_message_at IS NULL OR t.last_message_at <= t.inbox_dismissed_at)`;

export async function listInbox(opts: {
  agentId?: string;
  filter?: InboxFilter;
  limit?: number;
  publicUrlBase: string;
}): Promise<InboxItem[]> {
  const filter = opts.filter ?? "all";
  const where = [
    "NOT t.archived",
    `NOT (${DISMISSED_SQL})`,
    "($1::uuid IS NULL OR t.agent_id = $1)",
    filter === "unread" ? `(${UNREAD_SQL})` : null,
    filter === "needs_you" ? "t.status IN ('awaiting_input','awaiting_approval')" : null,
  ].filter(Boolean);

  const { rows } = await getPool().query<InboxRow>(
    `SELECT t.id, t.title, t.status, t.mode, t.source, t.schedule_id,
            t.agent_id, a.slug AS agent_slug, a.name AS agent_name, a.avatar AS agent_avatar,
            t.last_message_preview, t.last_message_at, t.read_at, t.last_error,
            art.artifacts
     FROM threads t
     LEFT JOIN agents a ON a.id = t.agent_id
     -- Three most recent artifacts per row, so "open today's brief" needs no
     -- second round trip. Indexed by artifacts_thread (003_thread_type.sql).
     LEFT JOIN LATERAL (
       SELECT json_agg(json_build_object('id', x.id, 'name', x.name)
                       ORDER BY x.created_at DESC) AS artifacts
       FROM (
         SELECT id, name, created_at FROM artifacts
         WHERE thread_id = t.id ORDER BY created_at DESC LIMIT 3
       ) x
     ) art ON true
     WHERE ${where.join(" AND ")}
     ORDER BY COALESCE(t.last_message_at, t.updated_at) DESC
     LIMIT $2`,
    [opts.agentId ?? null, opts.limit ?? 100],
  );

  return rows.map((r) => ({
    threadId: r.id,
    title: r.title,
    status: r.status,
    mode: r.mode,
    source: r.source,
    scheduleId: r.schedule_id,
    agentId: r.agent_id,
    // A thread whose agent row vanished still has to render.
    agentSlug: r.agent_slug ?? "conductor",
    agentName: r.agent_name ?? "Conductor",
    agentAvatar: r.agent_avatar,
    preview: r.last_message_preview ?? "",
    lastMessageAt: r.last_message_at?.toISOString() ?? null,
    unread: Boolean(r.last_message_at && (!r.read_at || r.read_at < r.last_message_at)),
    needsYou: r.status === "awaiting_input" || r.status === "awaiting_approval",
    error: r.last_error,
    artifacts: (r.artifacts ?? []).map((x) => ({
      ...x,
      url: `${opts.publicUrlBase}/artifacts/${x.id}/${encodeURIComponent(x.name)}`,
    })),
  }));
}

/** Unread totals, overall and per agent. Served by the threads_unread index. */
export async function inboxCounts(): Promise<{
  unreadByAgent: Record<string, number>;
  totalUnread: number;
}> {
  const { rows } = await getPool().query<{ agent_id: string | null; n: string }>(
    `SELECT t.agent_id, count(*)::text AS n
     FROM threads t
     WHERE NOT t.archived AND ${UNREAD_SQL}
     GROUP BY t.agent_id`,
  );
  const unreadByAgent: Record<string, number> = {};
  let totalUnread = 0;
  for (const r of rows) {
    const n = Number(r.n);
    totalUnread += n;
    if (r.agent_id) unreadByAgent[r.agent_id] = n;
  }
  return { unreadByAgent, totalUnread };
}

/** Mark one thread read. No-op on a thread that has never had a reply. */
export async function markRead(threadId: string): Promise<void> {
  await getPool().query("UPDATE threads SET read_at = now() WHERE id = $1", [threadId]);
}

/** Mark every unread thread read, optionally for one agent only. */
export async function markAllRead(agentId?: string): Promise<void> {
  await getPool().query(
    `UPDATE threads t SET read_at = now()
     WHERE NOT t.archived AND ($1::uuid IS NULL OR t.agent_id = $1) AND ${UNREAD_SQL}`,
    [agentId ?? null],
  );
}

/**
 * Dismiss one inbox row, or bring it back. Dismissing also marks it read: a
 * notification you cleared away should not keep counting as unread.
 */
export async function dismiss(threadId: string, dismissed: boolean): Promise<boolean> {
  const { rowCount } = await getPool().query(
    dismissed
      ? "UPDATE threads SET inbox_dismissed_at = now(), read_at = now() WHERE id = $1"
      : "UPDATE threads SET inbox_dismissed_at = NULL WHERE id = $1",
    [threadId],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Dismiss every row in an inbox view — the "Clear" button. Skips threads that
 * are running or waiting on you: clearing should not quietly bury a question
 * or a plan. Returns the ids so the caller can broadcast them and offer undo.
 */
export async function dismissInbox(opts: { agentId?: string; filter?: InboxFilter }): Promise<string[]> {
  const filter = opts.filter ?? "all";
  const { rows } = await getPool().query<{ id: string }>(
    `UPDATE threads t SET inbox_dismissed_at = now(), read_at = now()
     WHERE NOT t.archived AND NOT (${DISMISSED_SQL})
       AND ($1::uuid IS NULL OR t.agent_id = $1)
       AND t.status NOT IN ('running','awaiting_input','awaiting_approval')
       ${filter === "unread" ? `AND (${UNREAD_SQL})` : ""}
     RETURNING t.id`,
    [opts.agentId ?? null],
  );
  return rows.map((r) => r.id);
}
