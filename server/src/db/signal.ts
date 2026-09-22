import { getPool } from "./pool.js";

export interface SignalAttachment {
  id: string | null;
  contentType: string | null;
  filename: string | null;
  size: number | null;
}

export interface SignalQuote {
  /** sent_at of the quoted message. */
  id: number;
  author: string | null;
  text: string | null;
}

export interface SignalReaction {
  emoji: string;
  targetSentAt: number;
  targetAuthor: string | null;
  isRemove: boolean;
}

/** A message as parsed from signal-cli, before it has a row id. */
export interface SignalMessageInput {
  account: string;
  threadKey: string;
  groupId: string | null;
  threadName: string | null;
  peerNumber: string | null;
  direction: "in" | "out";
  sender: string;
  senderNumber: string | null;
  senderName: string | null;
  sentAt: number;
  body: string;
  attachments: SignalAttachment[];
  quote: SignalQuote | null;
  reaction: SignalReaction | null;
}

export interface SignalMessageRecord extends SignalMessageInput {
  id: number;
  edited: boolean;
  seen: boolean;
  receivedAt: string;
}

interface SignalMessageRow {
  id: string;
  account: string;
  thread_key: string;
  group_id: string | null;
  thread_name: string | null;
  peer_number: string | null;
  direction: "in" | "out";
  sender: string;
  sender_number: string | null;
  sender_name: string | null;
  sent_at: string;
  body: string;
  attachments: SignalAttachment[];
  quote: SignalQuote | null;
  reaction: SignalReaction | null;
  edited: boolean;
  seen: boolean;
  received_at: Date;
}

function toRecord(row: SignalMessageRow): SignalMessageRecord {
  return {
    id: Number(row.id),
    account: row.account,
    threadKey: row.thread_key,
    groupId: row.group_id,
    threadName: row.thread_name,
    peerNumber: row.peer_number,
    direction: row.direction,
    sender: row.sender,
    senderNumber: row.sender_number,
    senderName: row.sender_name,
    sentAt: Number(row.sent_at),
    body: row.body,
    attachments: row.attachments,
    quote: row.quote,
    reaction: row.reaction,
    edited: row.edited,
    seen: row.seen,
    receivedAt: row.received_at.toISOString(),
  };
}

/**
 * Store a message. Returns null when it was already stored — signal-cli can
 * redeliver after a restart, and (account, thread, sender, sent_at) is a
 * message's identity.
 */
export async function insertSignalMessage(m: SignalMessageInput): Promise<SignalMessageRecord | null> {
  const { rows } = await getPool().query<SignalMessageRow>(
    `INSERT INTO signal_messages
       (account, thread_key, group_id, thread_name, peer_number, direction, sender,
        sender_number, sender_name, sent_at, body, attachments, quote, reaction)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     ON CONFLICT (account, thread_key, sender, sent_at) DO NOTHING
     RETURNING *`,
    [
      m.account, m.threadKey, m.groupId, m.threadName, m.peerNumber, m.direction, m.sender,
      m.senderNumber, m.senderName, m.sentAt, m.body, JSON.stringify(m.attachments),
      m.quote ? JSON.stringify(m.quote) : null, m.reaction ? JSON.stringify(m.reaction) : null,
    ],
  );
  return rows[0] ? toRecord(rows[0]) : null;
}

/** Replace an edited message's text. False when the original was never stored. */
export async function applySignalEdit(
  account: string,
  threadKey: string,
  sender: string,
  targetSentAt: number,
  body: string,
): Promise<boolean> {
  const { rowCount } = await getPool().query(
    `UPDATE signal_messages SET body = $5, edited = true
     WHERE account = $1 AND thread_key = $2 AND sender = $3 AND sent_at = $4`,
    [account, threadKey, sender, targetSentAt, body],
  );
  return (rowCount ?? 0) > 0;
}

/** The newest `limit` messages of a thread, oldest first. */
export async function listSignalMessages(
  account: string,
  threadKey: string,
  limit: number,
): Promise<SignalMessageRecord[]> {
  const { rows } = await getPool().query<SignalMessageRow>(
    `SELECT * FROM (
       SELECT * FROM signal_messages WHERE account = $1 AND thread_key = $2
       ORDER BY id DESC LIMIT $3
     ) recent ORDER BY id`,
    [account, threadKey, limit],
  );
  return rows.map(toRecord);
}

/** A message in a thread by its Signal timestamp — the target of a quote-reply. */
export async function findSignalMessage(
  account: string,
  threadKey: string,
  sentAt: number,
): Promise<SignalMessageRecord | null> {
  const { rows } = await getPool().query<SignalMessageRow>(
    `SELECT * FROM signal_messages WHERE account = $1 AND thread_key = $2 AND sent_at = $3
     ORDER BY id LIMIT 1`,
    [account, threadKey, sentAt],
  );
  return rows[0] ? toRecord(rows[0]) : null;
}

/** Mark the incoming messages an agent was just shown (ids fromId..toId). */
export async function markSignalSeen(
  account: string,
  threadKey: string,
  fromId: number,
  toId: number,
): Promise<void> {
  await getPool().query(
    `UPDATE signal_messages SET seen = true
     WHERE account = $1 AND thread_key = $2 AND id BETWEEN $3 AND $4 AND direction = 'in' AND NOT seen`,
    [account, threadKey, fromId, toId],
  );
}

/**
 * The id a reply has to be newer than: the last thing this account said in
 * the thread, or the last message an agent was already shown, whichever is
 * later. 0 for a thread with neither.
 */
export async function signalReplyBaseline(account: string, threadKey: string): Promise<number> {
  const { rows } = await getPool().query<{ baseline: string }>(
    `SELECT COALESCE(MAX(id) FILTER (WHERE direction = 'out' OR seen), 0) AS baseline
     FROM signal_messages WHERE account = $1 AND thread_key = $2`,
    [account, threadKey],
  );
  return Number(rows[0]?.baseline ?? 0);
}

export async function hasSignalReplyAfter(account: string, threadKey: string, afterId: number): Promise<boolean> {
  const { rows } = await getPool().query(
    `SELECT 1 FROM signal_messages
     WHERE account = $1 AND thread_key = $2 AND direction = 'in' AND id > $3 LIMIT 1`,
    [account, threadKey, afterId],
  );
  return rows.length > 0;
}

export interface SignalThreadSummary {
  threadKey: string;
  groupId: string | null;
  /** Most recent non-null name the thread was seen under. */
  name: string | null;
  peerNumber: string | null;
  lastAt: number;
  lastBody: string;
  lastDirection: "in" | "out";
  lastSenderName: string | null;
  total: number;
  unread: number;
}

/** Threads this account has stored messages for, most recently active first. */
export async function listSignalThreads(account: string, limit: number): Promise<SignalThreadSummary[]> {
  const { rows } = await getPool().query<{
    thread_key: string;
    group_id: string | null;
    name: string | null;
    peer_number: string | null;
    sent_at: string;
    body: string;
    direction: "in" | "out";
    sender_name: string | null;
    total: string;
    unread: string;
  }>(
    `WITH latest AS (
       SELECT DISTINCT ON (thread_key) thread_key, group_id, sent_at, body, direction, sender_name, id
       FROM signal_messages WHERE account = $1
       ORDER BY thread_key, id DESC
     ), stats AS (
       SELECT thread_key,
              COUNT(*) AS total,
              COUNT(*) FILTER (WHERE direction = 'in' AND NOT seen) AS unread,
              (array_agg(thread_name ORDER BY id DESC) FILTER (WHERE thread_name IS NOT NULL))[1] AS name,
              (array_agg(peer_number ORDER BY id DESC) FILTER (WHERE peer_number IS NOT NULL))[1] AS peer_number
       FROM signal_messages WHERE account = $1
       GROUP BY thread_key
     )
     SELECT l.thread_key, l.group_id, l.sent_at, l.body, l.direction, l.sender_name,
            s.total, s.unread, s.name, s.peer_number
     FROM latest l JOIN stats s USING (thread_key)
     ORDER BY l.id DESC LIMIT $2`,
    [account, limit],
  );
  return rows.map((r) => ({
    threadKey: r.thread_key,
    groupId: r.group_id,
    name: r.name,
    peerNumber: r.peer_number,
    lastAt: Number(r.sent_at),
    lastBody: r.body,
    lastDirection: r.direction,
    lastSenderName: r.sender_name,
    total: Number(r.total),
    unread: Number(r.unread),
  }));
}

/** The stored thread for a phone number, if this account has talked to it. */
export async function signalThreadKeyForNumber(account: string, number: string): Promise<string | null> {
  const { rows } = await getPool().query<{ thread_key: string }>(
    `SELECT thread_key FROM signal_messages
     WHERE account = $1 AND group_id IS NULL AND (peer_number = $2 OR thread_key = $2)
     ORDER BY id DESC LIMIT 1`,
    [account, number],
  );
  return rows[0]?.thread_key ?? null;
}

/** Stored threads whose name matches exactly, ignoring case. */
export async function signalThreadsNamed(
  account: string,
  name: string,
): Promise<Array<{ threadKey: string; groupId: string | null; name: string }>> {
  const { rows } = await getPool().query<{ thread_key: string; group_id: string | null; thread_name: string }>(
    `SELECT DISTINCT ON (thread_key) thread_key, group_id, thread_name
     FROM signal_messages
     WHERE account = $1 AND lower(thread_name) = lower($2)
     ORDER BY thread_key, id DESC`,
    [account, name],
  );
  return rows.map((r) => ({ threadKey: r.thread_key, groupId: r.group_id, name: r.thread_name }));
}
