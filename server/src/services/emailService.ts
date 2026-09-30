import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import type { FastifyBaseLogger } from "fastify";
import { simpleParser, type AddressObject, type ParsedMail } from "mailparser";
import nodemailer from "nodemailer";
import type { EmailInboxStatus, SmtpSettingsRequest, SmtpSettingsResponse } from "@fastcar/shared";
import type { Config } from "../config.js";
import * as db from "../db/email.js";
import { imapflowFactory, type ImapClient, type ImapConnSettings, type ImapFactory } from "./imapClient.js";
import { decryptSecret, encryptSecret } from "./secrets.js";

/**
 * Email: SMTP sending (Feature 2) plus an IMAP inbox the agent can read.
 *
 * The whole config lives in `<dataDir>/smtp.json`. Passwords are encrypted at
 * rest (see services/secrets.ts). The file is mode 0600.
 *
 * When an IMAP host is set, a sync loop copies the mailbox into
 * email_messages (db/email.ts): a backfill of recent mail on first contact,
 * then whatever arrives, woken by IMAP IDLE with a polling fallback. Agents
 * read from that table, so listing and waiting for a reply never block on the
 * mail server. Like Signal, inbound mail is only stored — it does not start or
 * wake threads; an agent waits for it with email_read(wait_seconds).
 */
const SMTP_FILE = "smtp.json";

interface StoredSmtpSettings {
  host: string;
  port: number;
  username: string;
  /** Encrypted (base64 iv:ciphertext:tag). Blank when no password set. */
  passwordEnc: string;
  fromAddress: string;
  secure: boolean;
  /** Blank = the inbox is off. */
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  /** Blank = reuse the SMTP login. */
  imapUsername: string;
  imapPasswordEnc: string;
  imapMailbox: string;
}

export interface SendEmailResult {
  ok: boolean;
  message: string;
  messageId?: string;
}

export interface SendInput {
  to: string[];
  cc?: string[];
  subject?: string;
  body: string;
  /** Row id of the message being answered: threads the reply and fills in blanks. */
  replyToId?: number;
}

export interface SendResult {
  record: db.EmailMessageRecord;
  /** Recipients the SMTP server accepted. */
  accepted: string[];
  rejected: string[];
}

export type WaitOutcome = "arrived" | "timeout" | "aborted";

export interface ReadResult {
  threadKey: string | null;
  messages: db.EmailMessageRecord[];
  wait: { outcome: WaitOutcome; seconds: number } | null;
}

export interface EmailServiceOptions {
  imapFactory?: ImapFactory;
  /** Swapped for a stream transport in tests. */
  transportFactory?: (s: StoredSmtpSettings, password: string) => nodemailer.Transporter;
  /** Poll fallback when IDLE reports nothing (ms). */
  pollMs?: number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
}

/** First contact with a mailbox copies at most this much history. */
const BACKFILL_DAYS = 30;
const BACKFILL_MAX = 200;
/** Stored bodies are capped; an agent is shown far less than this anyway. */
const MAX_BODY = 200_000;

function smtpPath(cfg: Config): string {
  return path.join(cfg.dataDir, SMTP_FILE);
}

const encrypt = encryptSecret;
const decrypt = decryptSecret;

function emptySettings(): StoredSmtpSettings {
  return {
    host: "", port: 587, username: "", passwordEnc: "", fromAddress: "", secure: false,
    imapHost: "", imapPort: 993, imapSecure: true, imapUsername: "", imapPasswordEnc: "", imapMailbox: "INBOX",
  };
}

function loadStored(cfg: Config): StoredSmtpSettings {
  const file = smtpPath(cfg);
  if (!fs.existsSync(file)) return emptySettings();
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<StoredSmtpSettings>;
    return {
      host: raw.host ?? "",
      port: Number(raw.port) || 587,
      username: raw.username ?? "",
      passwordEnc: raw.passwordEnc ?? "",
      fromAddress: raw.fromAddress ?? "",
      secure: Boolean(raw.secure),
      imapHost: raw.imapHost ?? "",
      imapPort: Number(raw.imapPort) || 993,
      imapSecure: raw.imapSecure ?? true,
      imapUsername: raw.imapUsername ?? "",
      imapPasswordEnc: raw.imapPasswordEnc ?? "",
      imapMailbox: raw.imapMailbox || "INBOX",
    };
  } catch (err) {
    console.error("failed to parse smtp.json, resetting:", err);
    return emptySettings();
  }
}

function saveStored(cfg: Config, s: StoredSmtpSettings): void {
  const file = smtpPath(cfg);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(s, null, 2), { mode: 0o600 });
}

function imapKey(s: StoredSmtpSettings): string {
  return JSON.stringify([s.imapHost, s.imapPort, s.imapSecure, s.imapUsername, s.imapPasswordEnc, s.imapMailbox, s.username, s.passwordEnc]);
}

export class EmailService {
  private readonly events = new EventEmitter();
  private readonly imapFactory: ImapFactory;
  private readonly pollMs: number;
  private readonly minBackoffMs: number;
  private readonly maxBackoffMs: number;

  /** start() was called and stop() was not: settings changes (re)start the sync. */
  private wanted = false;
  private loop: Promise<void> | null = null;
  private loopAbort: AbortController | null = null;
  private inboxState: EmailInboxStatus["state"] = "stopped";
  private lastError: string | null = null;
  private lastSyncAt: Date | null = null;
  /** Messages are stored one at a time, in fetch order. */
  private ingestChain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly cfg: Config,
    private readonly opts: EmailServiceOptions = {},
  ) {
    this.imapFactory = opts.imapFactory ?? imapflowFactory;
    this.pollMs = opts.pollMs ?? 60_000;
    this.minBackoffMs = opts.minBackoffMs ?? 5_000;
    this.maxBackoffMs = opts.maxBackoffMs ?? 5 * 60_000;
    // One listener per agent waiting on mail; there is no leak to warn about.
    this.events.setMaxListeners(0);
  }

  // ---- settings --------------------------------------------------------------

  /** Read settings for the UI (passwords never returned). */
  getSettings(): SmtpSettingsResponse {
    const s = loadStored(this.cfg);
    const configured = Boolean(s.host && s.fromAddress && s.passwordEnc);
    return {
      host: s.host,
      port: s.port,
      username: s.username,
      fromAddress: s.fromAddress,
      secure: s.secure,
      configured,
      imapHost: s.imapHost,
      imapPort: s.imapPort,
      imapSecure: s.imapSecure,
      imapUsername: s.imapUsername,
      imapMailbox: s.imapMailbox,
      imapConfigured: this.imapConfigured(),
      imapStatus: this.status(),
    };
  }

  /** Persist settings. A blank password keeps the existing one. */
  saveSettings(req: SmtpSettingsRequest): SmtpSettingsResponse {
    const prev = loadStored(this.cfg);
    const passwordEnc =
      req.password && req.password.length ? encrypt(req.password, this.cfg) : prev.passwordEnc;
    const imapPasswordEnc =
      req.imapPassword && req.imapPassword.length ? encrypt(req.imapPassword, this.cfg) : prev.imapPasswordEnc;
    const next: StoredSmtpSettings = {
      host: req.host.trim(),
      port: Number(req.port) || 587,
      username: req.username.trim(),
      passwordEnc,
      fromAddress: req.fromAddress.trim(),
      secure: Boolean(req.secure),
      imapHost: (req.imapHost ?? prev.imapHost).trim(),
      imapPort: Number(req.imapPort ?? prev.imapPort) || 993,
      imapSecure: req.imapSecure ?? prev.imapSecure,
      imapUsername: (req.imapUsername ?? prev.imapUsername).trim(),
      imapPasswordEnc,
      imapMailbox: (req.imapMailbox ?? prev.imapMailbox).trim() || "INBOX",
    };
    saveStored(this.cfg, next);
    // Connect with the new login; leave a service nobody started stopped.
    if (this.wanted && imapKey(prev) !== imapKey(next)) void this.restart();
    return this.getSettings();
  }

  /** Enough to send: the email_send tool is offered only when this holds. */
  smtpConfigured(): boolean {
    const s = loadStored(this.cfg);
    return Boolean(s.host && s.fromAddress);
  }

  /** Enough to read: email_list/email_read are offered only when this holds. */
  imapConfigured(): boolean {
    const s = loadStored(this.cfg);
    return Boolean(s.imapHost && (s.imapUsername || s.username) && (s.imapPasswordEnc || s.passwordEnc));
  }

  /** The mailbox identity messages are stored under. */
  account(): string {
    const s = loadStored(this.cfg);
    return (s.imapUsername || s.username || s.fromAddress).toLowerCase();
  }

  status(): EmailInboxStatus {
    return {
      state: this.inboxState,
      error: this.inboxState === "down" ? this.lastError : null,
      lastSyncAt: this.lastSyncAt?.toISOString() ?? null,
    };
  }

  // ---- inbox sync -------------------------------------------------------------

  /** Start syncing the inbox. A no-op while IMAP is not configured. */
  start(): void {
    this.wanted = true;
    if (this.loop) return;
    const abort = new AbortController();
    this.loopAbort = abort;
    this.loop = this.runLoop(abort.signal).finally(() => {
      if (this.loopAbort === abort) {
        this.loop = null;
        this.loopAbort = null;
      }
    });
  }

  async stop(): Promise<void> {
    this.wanted = false;
    this.loopAbort?.abort();
    await this.loop;
    this.loop = null;
    this.loopAbort = null;
    await this.ingestChain;
    this.inboxState = "stopped";
  }

  private async restart(): Promise<void> {
    await this.stop();
    this.start();
  }

  /** Every stored message, as it is stored. Tests and waiters listen here. */
  onMessage(listener: (m: db.EmailMessageRecord) => void): () => void {
    this.events.on("message", listener);
    return () => this.events.off("message", listener);
  }

  private async runLoop(signal: AbortSignal): Promise<void> {
    let backoff = this.minBackoffMs;
    while (!signal.aborted) {
      const s = loadStored(this.cfg);
      if (!this.imapConfigured()) {
        this.inboxState = "stopped";
        return;
      }
      const conn: ImapConnSettings = {
        host: s.imapHost,
        port: s.imapPort,
        secure: s.imapSecure,
        username: s.imapUsername || s.username,
        password: decrypt(s.imapUsername ? s.imapPasswordEnc || s.passwordEnc : s.passwordEnc, this.cfg),
      };
      const client = this.imapFactory(conn);
      try {
        await client.connect();
        const box = await client.open(s.imapMailbox);
        this.inboxState = "running";
        this.lastError = null;
        backoff = this.minBackoffMs;
        while (!signal.aborted) {
          await this.syncOnce(client, s.imapMailbox, box.uidValidity);
          this.lastSyncAt = new Date();
          await client.waitForNew(this.pollMs, signal);
        }
      } catch (err) {
        if (signal.aborted) break;
        this.inboxState = "down";
        this.lastError = err instanceof Error ? err.message : String(err);
        console.error(`email inbox sync failed (retrying in ${Math.round(backoff / 1000)}s):`, this.lastError);
        await sleep(backoff, signal);
        backoff = Math.min(backoff * 2, this.maxBackoffMs);
      } finally {
        await client.close().catch(() => {});
      }
    }
  }

  /** Fetch everything newer than the last UID seen (or the backfill window). */
  private async syncOnce(client: ImapClient, mailbox: string, uidValidity: bigint): Promise<void> {
    const account = this.account();
    const state = await db.getEmailSyncState(account, mailbox);
    let uids: number[] | string;
    let lastUid: number;
    if (!state || state.uidvalidity !== uidValidity) {
      const since = new Date(Date.now() - BACKFILL_DAYS * 86_400_000);
      uids = (await client.searchSince(since)).slice(-BACKFILL_MAX);
      lastUid = 0;
      if (!uids.length) {
        // Nothing to backfill; remember the uidvalidity so the next pass
        // fetches incrementally instead of searching again.
        await db.setEmailSyncState(account, mailbox, { uidvalidity: uidValidity, lastUid: 0 });
        return;
      }
    } else {
      uids = `${state.lastUid + 1}:*`;
      lastUid = state.lastUid;
    }
    for await (const msg of client.fetchRaw(uids)) {
      // `N:*` always returns the newest message, even when its UID is below N.
      if (msg.uid <= lastUid) continue;
      try {
        await this.ingestRaw(msg.source, { account, mailbox, uidvalidity: uidValidity, uid: msg.uid });
      } catch (err) {
        // One unparseable message must not wedge the sync on its UID forever.
        console.error(`email: skipping UID ${msg.uid} in ${mailbox}:`, err);
      }
      lastUid = msg.uid;
      await db.setEmailSyncState(account, mailbox, { uidvalidity: uidValidity, lastUid });
    }
    if (!state || state.uidvalidity !== uidValidity) {
      await db.setEmailSyncState(account, mailbox, { uidvalidity: uidValidity, lastUid });
    }
  }

  /** Parse and store one raw message. Null when it was already stored. */
  ingestRaw(
    raw: Buffer,
    where: { account: string; mailbox: string | null; uidvalidity: bigint | null; uid: number | null },
  ): Promise<db.EmailMessageRecord | null> {
    const run = this.ingestChain.then(async () => {
      const parsed = await simpleParser(raw);
      const refs = referencesOf(parsed);
      const messageId = parsed.messageId?.trim() || syntheticMessageId(raw);
      const threadKey = await threadKeyFor(
        { messageId, inReplyTo: parsed.inReplyTo?.trim() || null, refs },
        (ids) => db.emailThreadForMessageIds(where.account, ids),
      );
      const from = addresses(parsed.from)[0] ?? null;
      const rec = await db.insertEmailMessage({
        ...where,
        messageId,
        threadKey,
        inReplyTo: parsed.inReplyTo?.trim() || null,
        refs,
        // Mail the account sent from another client (it appears when the
        // account emails itself, or when the synced mailbox is Sent).
        direction: from && from.address.toLowerCase() === this.fromAddress().toLowerCase() ? "out" : "in",
        fromAddr: from?.address ?? null,
        fromName: from?.name ?? null,
        to: addresses(parsed.to),
        cc: addresses(parsed.cc),
        replyTo: addresses(parsed.replyTo),
        subject: parsed.subject ?? "",
        sentAt: parsed.date ?? new Date(),
        bodyText: bodyOf(parsed).slice(0, MAX_BODY),
        attachments: parsed.attachments.map((a) => ({
          filename: a.filename ?? null,
          contentType: a.contentType ?? null,
          size: a.size ?? null,
        })),
      });
      if (rec) this.events.emit("message", rec);
      return rec;
    });
    this.ingestChain = run.catch((err) => console.error("email ingest failed:", err));
    return run;
  }

  private fromAddress(): string {
    return loadStored(this.cfg).fromAddress;
  }

  // ---- sending ----------------------------------------------------------------

  private buildTransport(): nodemailer.Transporter {
    const s = loadStored(this.cfg);
    if (!s.host || !s.fromAddress) {
      throw new Error("SMTP settings are not configured");
    }
    const password = decrypt(s.passwordEnc, this.cfg);
    if (this.opts.transportFactory) return this.opts.transportFactory(s, password);
    // Only 465 speaks implicit TLS; 587/25 greet in plaintext and upgrade via
    // STARTTLS. Taking the checkbox literally on those ports makes the TLS
    // handshake read the "220" banner ("wrong version number"), so there
    // "secure" means require STARTTLS instead.
    const implicitTls = s.secure && s.port === 465;
    return nodemailer.createTransport({
      host: s.host,
      port: s.port,
      secure: implicitTls,
      requireTLS: s.secure && !implicitTls,
      auth: password || s.username ? { user: s.username, pass: password } : undefined,
    });
  }

  /**
   * Send a message and store it in its thread. A reply (`replyToId`) goes to
   * the original's Reply-To (else its sender) unless `to` says otherwise,
   * gets a "Re:" subject, and carries In-Reply-To/References so the other
   * side's client threads it too.
   */
  async send(input: SendInput): Promise<SendResult> {
    const s = loadStored(this.cfg);
    if (!s.host || !s.fromAddress) throw new Error("SMTP settings are not configured");
    const account = this.account();

    let original: db.EmailMessageRecord | null = null;
    if (input.replyToId !== undefined) {
      original = await db.getEmailMessage(account, input.replyToId);
      if (!original) throw new Error(`No stored email #${input.replyToId} — email_list shows the ids.`);
    }
    const headers = original ? replyHeaders(original) : null;
    let to = input.to.map((a) => a.trim()).filter(Boolean);
    if (!to.length && original) {
      to = (original.direction === "out" ? original.to : original.replyTo.length ? original.replyTo : [
        { address: original.fromAddr ?? "", name: original.fromName },
      ]).map((a) => a.address).filter(Boolean);
    }
    if (!to.length) throw new Error("email_send needs at least one recipient.");
    const cc = (input.cc ?? []).map((a) => a.trim()).filter(Boolean);
    const subject = input.subject?.trim() || headers?.subject || "";
    if (!subject) throw new Error("email_send needs a subject for a new message.");

    const domain = s.fromAddress.split("@")[1] || "fastcar.local";
    const messageId = `<${randomUUID()}@${domain}>`;
    const info = await this.buildTransport().sendMail({
      from: s.fromAddress,
      to,
      cc: cc.length ? cc : undefined,
      subject,
      text: input.body,
      messageId,
      inReplyTo: headers?.inReplyTo,
      references: headers?.references,
    });
    const accepted = (info.accepted ?? []).map(String);
    const rejected = (info.rejected ?? []).map(String);

    const record = await db.insertEmailMessage({
      account,
      mailbox: null,
      uidvalidity: null,
      uid: null,
      messageId,
      threadKey: original?.threadKey ?? messageId,
      inReplyTo: headers?.inReplyTo ?? null,
      refs: headers?.references ?? [],
      direction: "out",
      fromAddr: s.fromAddress,
      fromName: null,
      to: to.map((address) => ({ address, name: null })),
      cc: cc.map((address) => ({ address, name: null })),
      replyTo: [],
      subject,
      sentAt: new Date(),
      bodyText: input.body,
      attachments: [],
    });
    if (!record) throw new Error(`sent, but ${messageId} was already stored`);
    this.events.emit("message", record);
    return { record, accepted, rejected };
  }

  /** Plain send with no threading — the `/email` slash command. */
  async sendEmail(
    to: string,
    subject: string,
    body: string,
    log?: FastifyBaseLogger,
  ): Promise<SendEmailResult> {
    const s = loadStored(this.cfg);
    if (!s.host || !s.fromAddress) {
      return { ok: false, message: "SMTP settings are not configured" };
    }
    try {
      const transport = this.buildTransport();
      const info = await transport.sendMail({
        from: s.fromAddress,
        to,
        subject,
        text: body,
      });
      log?.info(`email sent to ${to}: ${info.messageId}`);
      return { ok: true, message: `sent to ${to}`, messageId: info.messageId };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log?.error({ err }, "email send failed");
      return { ok: false, message };
    }
  }

  // ---- reading ----------------------------------------------------------------

  listThreads(opts: { query: string | null; unreadOnly: boolean; limit: number }): Promise<db.EmailThreadSummary[]> {
    return db.listEmailThreads(this.account(), opts);
  }

  /**
   * Read a thread (the one message `id` belongs to), optionally waiting for
   * new incoming mail first. Without `id`, waits for any new incoming message
   * (optionally from a matching sender) and shows its thread — what an agent
   * wants after submitting a web form that promises an emailed quote.
   */
  async read(
    opts: { id?: number; limit: number; waitSeconds?: number; fromContains?: string },
    signal?: AbortSignal,
  ): Promise<ReadResult> {
    const account = this.account();
    const fromContains = opts.fromContains?.trim() || null;
    let threadKey: string | null = null;
    if (opts.id !== undefined) {
      const msg = await db.getEmailMessage(account, opts.id);
      if (!msg) throw new Error(`No stored email #${opts.id} — email_list shows the ids.`);
      threadKey = msg.threadKey;
    }

    let wait: ReadResult["wait"] = null;
    if (opts.waitSeconds && opts.waitSeconds > 0) {
      const started = Date.now();
      const baseline = await db.emailReplyBaseline(account, threadKey);
      const { outcome, message } = await this.waitForMail(threadKey, baseline, fromContains, opts.waitSeconds * 1000, signal);
      wait = { outcome, seconds: Math.round((Date.now() - started) / 1000) };
      if (message && threadKey === null) threadKey = message.threadKey;
    }
    if (threadKey === null) {
      threadKey = (await db.latestIncomingEmail(account, fromContains))?.threadKey ?? null;
    }
    const messages = threadKey ? await db.listEmailThreadMessages(account, threadKey, opts.limit) : [];
    await db.markEmailSeen(account, messages.map((m) => m.id));
    return { threadKey, messages, wait };
  }

  /**
   * Resolve once an incoming message newer than `baseline` is stored (in the
   * thread, when one is given). Subscribes before checking the table, so a
   * message stored between the two is caught by one or the other.
   */
  private waitForMail(
    threadKey: string | null,
    baseline: number,
    fromContains: string | null,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<{ outcome: WaitOutcome; message: db.EmailMessageRecord | null }> {
    const account = this.account();
    const needle = fromContains?.toLowerCase() ?? null;
    return new Promise((resolve) => {
      let done = false;
      const finish = (outcome: WaitOutcome, message: db.EmailMessageRecord | null = null): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        unsubscribe();
        signal?.removeEventListener("abort", onAbort);
        resolve({ outcome, message });
      };
      const onAbort = (): void => finish("aborted");
      const timer = setTimeout(() => finish("timeout"), timeoutMs);
      const unsubscribe = this.onMessage((m) => {
        if (m.direction !== "in" || m.id <= baseline) return;
        if (threadKey !== null && m.threadKey !== threadKey) return;
        if (needle && !`${m.fromAddr ?? ""} ${m.fromName ?? ""}`.toLowerCase().includes(needle)) return;
        finish("arrived", m);
      });
      if (signal?.aborted) return finish("aborted");
      signal?.addEventListener("abort", onAbort, { once: true });
      db.firstEmailInAfter(account, threadKey, baseline, fromContains).then(
        (m) => m && finish("arrived", m),
        () => {},
      );
    });
  }
}

// ---- pure helpers (exported for tests) ----------------------------------------

/**
 * Which conversation a message belongs to: the stored thread of any message
 * it answers, else the conversation root it names, else a new thread of its
 * own. Looking up stored messages first is what keeps a thread together when
 * a client trims References.
 */
export async function threadKeyFor(
  m: { messageId: string; inReplyTo: string | null; refs: string[] },
  lookup: (ids: string[]) => Promise<string | null>,
): Promise<string> {
  const named = [...new Set([m.inReplyTo, ...m.refs].filter((x): x is string => Boolean(x)))];
  const existing = await lookup(named);
  if (existing) return existing;
  return m.refs[0] ?? m.inReplyTo ?? m.messageId;
}

/** Strip any stack of Re:/Fwd:/AW: prefixes. */
export function normalizeSubject(subject: string): string {
  return subject.replace(/^(\s*(re|fwd?|aw|sv|antw)(\[\d+\])?\s*:\s*)+/i, "").trim();
}

/** Headers for a reply to `orig`. */
export function replyHeaders(orig: { messageId: string; refs: string[]; subject: string }): {
  inReplyTo: string;
  references: string[];
  subject: string;
} {
  const references = [...orig.refs.filter((r) => r !== orig.messageId), orig.messageId];
  return { inReplyTo: orig.messageId, references, subject: `Re: ${normalizeSubject(orig.subject)}` };
}

/**
 * Drop quoted history from a body for display: `>` lines and everything from
 * an "On … wrote:" / "-----Original Message-----" marker on. The full body
 * stays stored.
 */
export function stripQuoted(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const next = lines[i + 1] ?? "";
    if (/^-{2,}\s*Original Message\s*-{2,}/i.test(line)) break;
    if (/^On .+wrote:\s*$/i.test(line) || (/^On .+/i.test(line) && /wrote:\s*$/i.test(next))) break;
    if (/^\s*>/.test(line)) continue;
    out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function referencesOf(parsed: ParsedMail): string[] {
  const r = parsed.references;
  const list = Array.isArray(r) ? r : r ? r.split(/\s+/) : [];
  return list.map((x) => x.trim()).filter(Boolean);
}

function addresses(field: AddressObject | AddressObject[] | undefined): db.EmailAddress[] {
  const objs = Array.isArray(field) ? field : field ? [field] : [];
  const out: db.EmailAddress[] = [];
  for (const o of objs) {
    for (const v of o.value) {
      for (const a of v.group ?? [v]) {
        if (a.address) out.push({ address: a.address, name: a.name || null });
      }
    }
  }
  return out;
}

function bodyOf(parsed: ParsedMail): string {
  if (parsed.text?.trim()) return parsed.text;
  if (!parsed.html) return "";
  return parsed.html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function syntheticMessageId(raw: Buffer): string {
  // A message without a Message-ID still needs a stable identity for dedupe.
  return `<no-id-${createHash("sha1").update(raw).digest("hex")}@fastcar.local>`;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done(): void {
      clearTimeout(t);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}
