import { getPool } from "./pool.js";

export interface EmailAddress {
  address: string;
  name: string | null;
}

export interface EmailAttachmentMeta {
  filename: string | null;
  contentType: string | null;
  size: number | null;
}

/** A message as parsed (incoming) or composed (outgoing), before it has a row id. */
export interface EmailMessageInput {
  account: string;
  mailbox: string | null;
  uidvalidity: bigint | null;
  uid: number | null;
  messageId: string;
  threadKey: string;
  inReplyTo: string | null;
  refs: string[];
  direction: "in" | "out";
  fromAddr: string | null;
  fromName: string | null;
  to: EmailAddress[];
  cc: EmailAddress[];
  replyTo: EmailAddress[];
  subject: string;
  sentAt: Date;
  bodyText: string;
  attachments: EmailAttachmentMeta[];
}

export interface EmailMessageRecord extends Omit<EmailMessageInput, "uidvalidity"> {
  id: number;
  seen: boolean;
}

interface EmailMessageRow {
  id: string;
  account: string;
  mailbox: string | null;
  uid: string | null;
  message_id: string;
  thread_key: string;
  in_reply_to: string | null;
  refs: string[];
  direction: "in" | "out";
  from_addr: string | null;
  from_name: string | null;
  to_addrs: EmailAddress[];
  cc_addrs: EmailAddress[];
  reply_to_addrs: EmailAddress[];
  subject: string;
  sent_at: Date;
  body_text: string;
  attachments: EmailAttachmentMeta[];
  seen: boolean;
}

function toRecord(row: EmailMessageRow): EmailMessageRecord {
  return {
    id: Number(row.id),
    account: row.account,
    mailbox: row.mailbox,
    uid: row.uid === null ? null : Number(row.uid),
    messageId: row.message_id,
    threadKey: row.thread_key,
    inReplyTo: row.in_reply_to,
    refs: row.refs,
    direction: row.direction,
    fromAddr: row.from_addr,
    fromName: row.from_name,
    to: row.to_addrs,
    cc: row.cc_addrs,
    replyTo: row.reply_to_addrs,
    subject: row.subject,
    sentAt: row.sent_at,
    bodyText: row.body_text,
    attachments: row.attachments,
    seen: row.seen,
  };
}

/**
 * Store a message. Returns null when this Message-ID is already stored — a
 * resync after a uidvalidity change, or our own sent mail showing up again in
 * the inbox (e.g. a message addressed to ourselves).
 */
export async function insertEmailMessage(m: EmailMessageInput): Promise<EmailMessageRecord | null> {
  const { rows } = await getPool().query<EmailMessageRow>(
    `INSERT INTO email_messages
       (account, mailbox, uidvalidity, uid, message_id, thread_key, in_reply_to, refs, direction,
        from_addr, from_name, to_addrs, cc_addrs, reply_to_addrs, subject, sent_at, body_text, attachments)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
     ON CONFLICT (account, message_id) DO NOTHING
     RETURNING *`,
    [
      m.account, m.mailbox, m.uidvalidity === null ? null : m.uidvalidity.toString(), m.uid,
      m.messageId, m.threadKey, m.inReplyTo, m.refs, m.direction, m.fromAddr, m.fromName,
      JSON.stringify(m.to), JSON.stringify(m.cc), JSON.stringify(m.replyTo),
      m.subject, m.sentAt, m.bodyText, JSON.stringify(m.attachments),
    ],
  );
  return rows[0] ? toRecord(rows[0]) : null;
}

/** The thread of the most recent stored message carrying one of these Message-IDs. */
export async function emailThreadForMessageIds(account: string, messageIds: string[]): Promise<string | null> {
  if (!messageIds.length) return null;
  const { rows } = await getPool().query<{ thread_key: string }>(
    `SELECT thread_key FROM email_messages
     WHERE account = $1 AND message_id = ANY($2::text[])
     ORDER BY id DESC LIMIT 1`,
    [account, messageIds],
  );
  return rows[0]?.thread_key ?? null;
}

export async function getEmailMessage(account: string, id: number): Promise<EmailMessageRecord | null> {
  const { rows } = await getPool().query<EmailMessageRow>(
    "SELECT * FROM email_messages WHERE account = $1 AND id = $2",
    [account, id],
  );
  return rows[0] ? toRecord(rows[0]) : null;
}

/** The newest `limit` messages of a thread, oldest first. */
export async function listEmailThreadMessages(
  account: string,
  threadKey: string,
  limit: number,
): Promise<EmailMessageRecord[]> {
  const { rows } = await getPool().query<EmailMessageRow>(
    `SELECT * FROM (
       SELECT * FROM email_messages WHERE account = $1 AND thread_key = $2
       ORDER BY sent_at DESC, id DESC LIMIT $3
     ) recent ORDER BY sent_at, id`,
    [account, threadKey, limit],
  );
  return rows.map(toRecord);
}

/** The newest incoming message, optionally from a sender matching `fromContains`. */
export async function latestIncomingEmail(
  account: string,
  fromContains: string | null,
): Promise<EmailMessageRecord | null> {
  const { rows } = await getPool().query<EmailMessageRow>(
    `SELECT * FROM email_messages
     WHERE account = $1 AND direction = 'in'
       AND ($2::text IS NULL OR from_addr ILIKE '%' || $2 || '%' OR from_name ILIKE '%' || $2 || '%')
     ORDER BY id DESC LIMIT 1`,
    [account, fromContains],
  );
  return rows[0] ? toRecord(rows[0]) : null;
}

export async function markEmailSeen(account: string, ids: number[]): Promise<void> {
  if (!ids.length) return;
  await getPool().query(
    `UPDATE email_messages SET seen = true
     WHERE account = $1 AND id = ANY($2::bigint[]) AND direction = 'in' AND NOT seen`,
    [account, ids],
  );
}

/**
 * The id a reply has to be newer than. For a thread: the last thing this
 * account sent in it or the last message an agent was already shown. With no
 * thread ("any new mail"): the newest stored message, so a backlog of unread
 * mail does not count as new.
 */
export async function emailReplyBaseline(account: string, threadKey: string | null): Promise<number> {
  const { rows } = await getPool().query<{ baseline: string }>(
    threadKey === null
      ? "SELECT COALESCE(MAX(id), 0) AS baseline FROM email_messages WHERE account = $1"
      : `SELECT COALESCE(MAX(id) FILTER (WHERE direction = 'out' OR seen), 0) AS baseline
         FROM email_messages WHERE account = $1 AND thread_key = $2`,
    threadKey === null ? [account] : [account, threadKey],
  );
  return Number(rows[0]?.baseline ?? 0);
}

/** The first incoming message newer than `afterId` that matches, if any. */
export async function firstEmailInAfter(
  account: string,
  threadKey: string | null,
  afterId: number,
  fromContains: string | null,
): Promise<EmailMessageRecord | null> {
  const { rows } = await getPool().query<EmailMessageRow>(
    `SELECT * FROM email_messages
     WHERE account = $1 AND direction = 'in' AND id > $2
       AND ($3::text IS NULL OR thread_key = $3)
       AND ($4::text IS NULL OR from_addr ILIKE '%' || $4 || '%' OR from_name ILIKE '%' || $4 || '%')
     ORDER BY id LIMIT 1`,
    [account, afterId, threadKey, fromContains],
  );
  return rows[0] ? toRecord(rows[0]) : null;
}

export interface EmailThreadSummary {
  threadKey: string;
  subject: string;
  /** Row id of the newest message — what email_read and reply_to_id take. */
  lastId: number;
  lastAt: Date;
  lastDirection: "in" | "out";
  lastFrom: string | null;
  lastBody: string;
  participants: string[];
  total: number;
  unread: number;
}

/** Threads, most recently active first. `query` matches subject, sender or body. */
export async function listEmailThreads(
  account: string,
  opts: { query: string | null; unreadOnly: boolean; limit: number },
): Promise<EmailThreadSummary[]> {
  const { rows } = await getPool().query<{
    thread_key: string;
    subject: string;
    id: string;
    sent_at: Date;
    direction: "in" | "out";
    from_addr: string | null;
    from_name: string | null;
    body_text: string;
    participants: string[] | null;
    total: string;
    unread: string;
  }>(
    `WITH matching AS (
       SELECT DISTINCT thread_key FROM email_messages
       WHERE account = $1
         AND ($2::text IS NULL OR subject ILIKE '%' || $2 || '%' OR from_addr ILIKE '%' || $2 || '%'
              OR from_name ILIKE '%' || $2 || '%' OR body_text ILIKE '%' || $2 || '%')
     ), latest AS (
       SELECT DISTINCT ON (thread_key) thread_key, subject, id, sent_at, direction, from_addr, from_name, body_text
       FROM email_messages WHERE account = $1 AND thread_key IN (SELECT thread_key FROM matching)
       ORDER BY thread_key, sent_at DESC, id DESC
     ), stats AS (
       SELECT thread_key,
              COUNT(*) AS total,
              COUNT(*) FILTER (WHERE direction = 'in' AND NOT seen) AS unread,
              array_agg(DISTINCT COALESCE(from_name, from_addr)) FILTER (WHERE direction = 'in') AS participants
       FROM email_messages WHERE account = $1 AND thread_key IN (SELECT thread_key FROM matching)
       GROUP BY thread_key
     )
     SELECT l.*, s.total, s.unread, s.participants
     FROM latest l JOIN stats s USING (thread_key)
     WHERE NOT $3::boolean OR s.unread > 0
     ORDER BY l.sent_at DESC LIMIT $4`,
    [account, opts.query, opts.unreadOnly, opts.limit],
  );
  return rows.map((r) => ({
    threadKey: r.thread_key,
    subject: r.subject,
    lastId: Number(r.id),
    lastAt: r.sent_at,
    lastDirection: r.direction,
    lastFrom: r.from_name ?? r.from_addr,
    lastBody: r.body_text,
    participants: r.participants ?? [],
    total: Number(r.total),
    unread: Number(r.unread),
  }));
}

export interface EmailSyncState {
  uidvalidity: bigint;
  lastUid: number;
}

export async function getEmailSyncState(account: string, mailbox: string): Promise<EmailSyncState | null> {
  const { rows } = await getPool().query<{ uidvalidity: string; last_uid: string }>(
    "SELECT uidvalidity, last_uid FROM email_sync_state WHERE account = $1 AND mailbox = $2",
    [account, mailbox],
  );
  const r = rows[0];
  return r ? { uidvalidity: BigInt(r.uidvalidity), lastUid: Number(r.last_uid) } : null;
}

export async function setEmailSyncState(account: string, mailbox: string, s: EmailSyncState): Promise<void> {
  await getPool().query(
    `INSERT INTO email_sync_state (account, mailbox, uidvalidity, last_uid, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (account, mailbox) DO UPDATE
       SET uidvalidity = EXCLUDED.uidvalidity, last_uid = EXCLUDED.last_uid, updated_at = now()`,
    [account, mailbox, s.uidvalidity.toString(), s.lastUid],
  );
}
