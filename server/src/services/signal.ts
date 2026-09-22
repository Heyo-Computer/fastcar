import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import type { Config } from "../config.js";
import * as db from "../db/signal.js";
import type {
  SignalAttachment,
  SignalMessageInput,
  SignalMessageRecord,
  SignalQuote,
  SignalReaction,
} from "../db/signal.js";

/**
 * Signal messaging through signal-cli (https://github.com/AsamK/signal-cli).
 *
 * fastcar runs `signal-cli -a <account> jsonRpc` as a long-lived child: requests
 * go in on stdin and responses come back on stdout as line-delimited JSON-RPC,
 * matched by id (signal-cli answers out of order). In this mode signal-cli
 * receives continuously and pushes each incoming message as a `receive`
 * notification. Those are written to Postgres (db/signal.ts), because
 * signal-cli keeps no history: a message it has handed over is gone, and the
 * table is the only way an agent can read a thread back.
 *
 * The account has to be registered or linked before this can start —
 * `signal-cli --data-dir <dir> link -n fastcar`, with fastcar's process not
 * running against that dir. Until then signal-cli exits at once with "User …
 * is not registered."; the service records that as the reason Signal is down,
 * fails tool calls with it, and keeps retrying on a backoff, so it comes up
 * within a minute of the account being linked without a restart.
 */

const DEFAULT_RPC_TIMEOUT_MS = 30_000;
/** Sending uploads attachments and fans out to every group member. */
const SEND_TIMEOUT_MS = 120_000;
/** A child that stayed up this long was healthy; the next failure starts the backoff over. */
const HEALTHY_AFTER_MS = 30_000;
/**
 * stderr from a child younger than this is only kept for the exit summary: a
 * startup failure ("not registered") would otherwise be echoed on every retry.
 */
const QUIET_STARTUP_MS = 5_000;
const STDERR_TAIL = 20;

export interface SignalOptions {
  account: string;
  cliPath: string;
  dataDir: string;
  /** Restart backoff bounds; tests shorten them. */
  minBackoffMs?: number;
  maxBackoffMs?: number;
}

export type SignalState = "stopped" | "running" | "down";

export interface SignalStatus {
  state: SignalState;
  account: string;
  dataDir: string;
  /** Why signal-cli is not running, when state is "down". */
  error: string | null;
}

/** A tool call that cannot proceed because signal-cli is not running. */
export class SignalUnavailableError extends Error {}

/** A thread argument that names no thread, or several. */
export class SignalThreadError extends Error {}

export type SendTarget = { groupId: string } | { recipient: string };

export interface ResolvedThread {
  threadKey: string;
  /** Human name for the thread, when one is known. */
  name: string | null;
  target: SendTarget;
}

export interface SendResult {
  thread: ResolvedThread;
  timestamp: number;
  delivered: number;
  failures: Array<{ recipient: string; type: string }>;
}

export type WaitOutcome = "replied" | "timeout" | "aborted";

export interface ReadResult {
  thread: ResolvedThread;
  messages: SignalMessageRecord[];
  wait: { outcome: WaitOutcome; seconds: number } | null;
}

export interface SignalGroup {
  id: string;
  name: string | null;
  memberCount: number;
}

export interface SignalContact {
  number: string | null;
  uuid: string | null;
  /** Contact name, nickname and profile name, most specific first. */
  names: string[];
}

// ---------------------------------------------------------------------------
// Envelope parsing
// ---------------------------------------------------------------------------

/** The parts of signal-cli's message-envelope schema this integration reads. */
interface RawDataMessage {
  timestamp?: number;
  message?: string | null;
  attachments?: Array<{ id?: string; contentType?: string; filename?: string | null; size?: number }>;
  groupInfo?: { groupId?: string; groupName?: string; type?: string };
  quote?: { id: number; author?: string; authorNumber?: string; authorUuid?: string; text?: string | null };
  reaction?: {
    emoji?: string;
    targetAuthor?: string;
    targetAuthorNumber?: string;
    targetAuthorUuid?: string;
    targetSentTimestamp: number;
    isRemove: boolean;
  };
  sticker?: unknown;
}

interface RawSentMessage extends RawDataMessage {
  destination?: string | null;
  destinationNumber?: string | null;
  destinationUuid?: string | null;
  editMessage?: { targetSentTimestamp: number; dataMessage?: RawDataMessage };
}

export interface RawEnvelope {
  source?: string | null;
  sourceNumber?: string | null;
  sourceUuid?: string | null;
  sourceName?: string | null;
  timestamp?: number;
  dataMessage?: RawDataMessage;
  editMessage?: { targetSentTimestamp: number; dataMessage?: RawDataMessage };
  syncMessage?: { sentMessage?: RawSentMessage };
}

export type ParsedEnvelope =
  | { kind: "message"; message: SignalMessageInput }
  /** An edit replaces the stored text; `message` is stored instead if the original never was. */
  | { kind: "edit"; targetSentAt: number; message: SignalMessageInput };

interface Content {
  body: string;
  attachments: SignalAttachment[];
  quote: SignalQuote | null;
  reaction: SignalReaction | null;
}

function contentOf(dm: RawDataMessage | undefined): Content | null {
  if (!dm) return null;
  let body = dm.message ?? "";
  if (!body && dm.sticker) body = "[sticker]";
  const attachments: SignalAttachment[] = (dm.attachments ?? []).map((a) => ({
    id: a.id ?? null,
    contentType: a.contentType ?? null,
    filename: a.filename ?? null,
    size: a.size ?? null,
  }));
  const r = dm.reaction;
  const reaction: SignalReaction | null = r?.emoji
    ? {
        emoji: r.emoji,
        targetSentAt: r.targetSentTimestamp,
        targetAuthor: r.targetAuthorUuid ?? r.targetAuthorNumber ?? r.targetAuthor ?? null,
        isRemove: Boolean(r.isRemove),
      }
    : null;
  // Group updates, profile-key and expiry changes, deletes: nothing to read.
  if (!body && !attachments.length && !reaction) return null;
  const q = dm.quote;
  const quote: SignalQuote | null = q
    ? { id: q.id, author: q.authorUuid ?? q.authorNumber ?? q.author ?? null, text: q.text ?? null }
    : null;
  return { body, attachments, quote, reaction };
}

/**
 * Turn one signal-cli envelope into a message to store, or null when it holds
 * nothing an agent would read (receipts, typing, calls, stories, group
 * housekeeping).
 *
 * Two envelope shapes carry messages:
 * - `dataMessage` / `editMessage`: someone else wrote it — incoming.
 * - `syncMessage.sentMessage`: the account's *other* device (the phone this
 *   was linked from) sent it — outgoing, so the history shows both sides.
 *   The exception is Note to Self: a sync message addressed to the account
 *   itself is the user typing on their phone, which is incoming as far as an
 *   agent is concerned — it lets a linked personal account talk to the agent
 *   without a second number.
 */
export function parseEnvelope(account: string, env: RawEnvelope): ParsedEnvelope | null {
  const sent = env.syncMessage?.sentMessage;
  if (sent) {
    const edit = sent.editMessage;
    const data = edit?.dataMessage ?? sent;
    const content = contentOf(data);
    if (!content) return null;
    const groupId = sent.groupInfo?.groupId ?? data.groupInfo?.groupId ?? null;
    const destination = sent.destinationUuid ?? sent.destinationNumber ?? sent.destination ?? null;
    if (!groupId && !destination) return null;
    const toSelf =
      !groupId &&
      ((env.sourceUuid != null && sent.destinationUuid === env.sourceUuid) ||
        sent.destinationNumber === account ||
        sent.destination === account);
    const message: SignalMessageInput = {
      account,
      threadKey: groupId ? `group:${groupId}` : destination!,
      groupId,
      threadName: sent.groupInfo?.groupName ?? data.groupInfo?.groupName ?? null,
      peerNumber: groupId ? null : (sent.destinationNumber ?? null),
      direction: toSelf ? "in" : "out",
      sender: account,
      senderNumber: account,
      senderName: toSelf ? "me (another device)" : null,
      sentAt: data.timestamp ?? env.timestamp ?? Date.now(),
      ...content,
    };
    return edit ? { kind: "edit", targetSentAt: edit.targetSentTimestamp, message } : { kind: "message", message };
  }

  const edit = env.editMessage;
  const data = edit?.dataMessage ?? env.dataMessage;
  const content = contentOf(data);
  if (!data || !content) return null;
  const sender = env.sourceUuid ?? env.sourceNumber ?? env.source ?? null;
  if (!sender) return null;
  const groupId = data.groupInfo?.groupId ?? null;
  const message: SignalMessageInput = {
    account,
    threadKey: groupId ? `group:${groupId}` : sender,
    groupId,
    threadName: groupId ? (data.groupInfo?.groupName ?? null) : (env.sourceName ?? null),
    peerNumber: groupId ? null : (env.sourceNumber ?? null),
    direction: "in",
    sender,
    senderNumber: env.sourceNumber ?? null,
    senderName: env.sourceName ?? null,
    sentAt: data.timestamp ?? env.timestamp ?? Date.now(),
    ...content,
  };
  return edit ? { kind: "edit", targetSentAt: edit.targetSentTimestamp, message } : { kind: "message", message };
}

// ---------------------------------------------------------------------------
// Thread arguments
// ---------------------------------------------------------------------------

const E164 = /^\+[1-9]\d{5,14}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Accepts "+1 (555) 123-4567" as well as "+15551234567". */
export function normalizeNumber(input: string): string | null {
  if (!input.startsWith("+")) return null;
  const compact = `+${input.slice(1).replace(/[\s().-]/g, "")}`;
  return E164.test(compact) ? compact : null;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

interface Pending {
  settle: (err: Error | null, result?: unknown) => void;
}

interface RawGroup {
  id: string;
  name?: string | null;
  isMember?: boolean;
  members?: unknown[];
}

interface RawContact {
  number?: string | null;
  uuid?: string | null;
  name?: string | null;
  nickName?: string | null;
  givenName?: string | null;
  familyName?: string | null;
  profile?: { givenName?: string | null; familyName?: string | null } | null;
}

interface RawSendResult {
  recipientAddress?: { uuid?: string | null; number?: string | null; username?: string | null };
  type?: string;
}

export class SignalService {
  readonly account: string;
  readonly dataDir: string;
  private readonly cliPath: string;
  private readonly minBackoffMs: number;
  private readonly maxBackoffMs: number;

  private child: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private state: SignalState = "stopped";
  private lastError: string | null = null;
  private stderrTail: string[] = [];
  private startedAt = 0;
  private backoffMs: number;
  private restartTimer: NodeJS.Timeout | null = null;
  private nextRestartAt = 0;
  private stopping = false;
  /** Envelopes are stored one at a time, in arrival order. */
  private ingest: Promise<void> = Promise.resolve();
  private readonly events = new EventEmitter();

  constructor(opts: SignalOptions) {
    this.account = opts.account;
    this.cliPath = opts.cliPath;
    this.dataDir = opts.dataDir;
    this.minBackoffMs = opts.minBackoffMs ?? 2_000;
    this.maxBackoffMs = opts.maxBackoffMs ?? 60_000;
    this.backoffMs = this.minBackoffMs;
    // One listener per agent waiting on a reply; there is no leak to warn about.
    this.events.setMaxListeners(0);
  }

  /** Undefined when SIGNAL_ACCOUNT is not set — Signal is opt-in. */
  static fromConfig(cfg: Config): SignalService | undefined {
    return cfg.signal ? new SignalService(cfg.signal) : undefined;
  }

  start(): void {
    this.stopping = false;
    if (!this.child) this.spawnChild();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    const child = this.child;
    this.state = "stopped";
    if (!child) return;
    const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 3_000);
    await exited;
    clearTimeout(timer);
    await this.ingest;
  }

  status(): SignalStatus {
    return {
      state: this.state,
      account: this.account,
      dataDir: this.dataDir,
      error: this.state === "down" ? this.lastError : null,
    };
  }

  /** Where signal-cli saved an incoming attachment. */
  attachmentPath(id: string): string {
    return path.join(this.dataDir, "attachments", id);
  }

  /** Every stored message, as it is stored. Tests and waiters listen here. */
  onMessage(listener: (m: SignalMessageRecord) => void): () => void {
    this.events.on("message", listener);
    return () => this.events.off("message", listener);
  }

  // ---- process -------------------------------------------------------------

  private spawnChild(): void {
    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    const args = [
      "--data-dir", this.dataDir,
      "-a", this.account,
      "jsonRpc",
      // Stories are not threads; avatars and sticker packs are disk nobody reads.
      "--ignore-stories", "--ignore-avatars", "--ignore-stickers",
    ];
    const child = spawn(this.cliPath, args, { stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    this.state = "running";
    this.startedAt = Date.now();
    this.stderrTail = [];

    readline.createInterface({ input: child.stdout }).on("line", (line) => this.onLine(line));
    readline.createInterface({ input: child.stderr }).on("line", (line) => {
      if (!line.trim()) return;
      this.stderrTail.push(line);
      if (this.stderrTail.length > STDERR_TAIL) this.stderrTail.shift();
      if (!this.stopping && Date.now() - this.startedAt >= QUIET_STARTUP_MS) console.warn(`[signal-cli] ${line}`);
    });
    // stdin errors (EPIPE when the child dies mid-write) surface as the exit below.
    child.stdin.on("error", () => {});

    let spawnError: string | null = null;
    child.on("error", (err: NodeJS.ErrnoException) => {
      spawnError =
        err.code === "ENOENT"
          ? `signal-cli was not found at "${this.cliPath}" (set SIGNAL_CLI_PATH)`
          : `signal-cli failed to start: ${err.message}`;
    });
    child.on("close", (code, sig) => this.onExit(child, spawnError ?? this.describeExit(code, sig)));
  }

  private describeExit(code: number | null, sig: NodeJS.Signals | null): string {
    // signal-cli's first stderr line is the reason ("User +1… is not
    // registered."); what follows is usually a stack trace.
    const first = this.stderrTail.find((l) => !/^\s+at\s/.test(l));
    const how = sig ? `killed by ${sig}` : `exit code ${code}`;
    return first ? `${first.trim().slice(0, 300)} (${how})` : `signal-cli exited (${how})`;
  }

  private onExit(child: ChildProcessWithoutNullStreams, reason: string): void {
    if (this.child !== child) return;
    this.child = null;
    for (const p of this.pending.values()) p.settle(new SignalUnavailableError(this.explain(reason)));
    this.pending.clear();
    if (this.stopping) {
      this.state = "stopped";
      return;
    }
    this.state = "down";
    const wasHealthy = Date.now() - this.startedAt >= HEALTHY_AFTER_MS;
    // An unlinked account fails the same way every minute until someone links
    // it; say so once, not forever.
    if (wasHealthy || reason !== this.lastError) {
      console.warn(`[signal] ${reason}; retrying with backoff (repeats of this error are not logged)`);
    }
    this.lastError = reason;
    if (wasHealthy) this.backoffMs = this.minBackoffMs;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
    this.nextRestartAt = Date.now() + delay;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.stopping) this.spawnChild();
    }, delay);
    this.restartTimer.unref();
  }

  /** The error text a tool call gets while signal-cli is down. */
  private explain(reason: string): string {
    const parts = [`Signal is unavailable: ${reason}.`];
    if (/not registered/i.test(reason)) {
      parts.push(
        `The account ${this.account} has not been linked yet. Stop fastcar (or unset SIGNAL_ACCOUNT), ` +
          `run \`signal-cli --data-dir ${this.dataDir} link -n fastcar\`, and scan the printed sgnl:// link ` +
          "as a QR code from the phone (Signal → Settings → Linked devices).",
      );
    }
    if (!this.stopping) parts.push("fastcar restarts signal-cli automatically; it is not something to retry right away.");
    return parts.join(" ");
  }

  private unavailable(): SignalUnavailableError {
    if (this.state === "stopped") return new SignalUnavailableError("Signal is not running (the server is shutting down).");
    const wait = Math.max(0, Math.round((this.nextRestartAt - Date.now()) / 1000));
    return new SignalUnavailableError(`${this.explain(this.lastError ?? "signal-cli is not running")} Next attempt in ${wait}s.`);
  }

  private onLine(line: string): void {
    let msg: {
      id?: number | string | null;
      result?: unknown;
      error?: { code?: number; message?: string; data?: unknown };
      method?: string;
      params?: { envelope?: RawEnvelope; result?: { envelope?: RawEnvelope } };
    };
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.id != null && ("result" in msg || "error" in msg)) {
      const p = this.pending.get(Number(msg.id));
      if (!p) return;
      if (msg.error) p.settle(new Error(rpcErrorText(msg.error)));
      else p.settle(null, msg.result);
      return;
    }
    if (msg.method === "receive") {
      // Automatic receiving puts the envelope in params; a subscribeReceive
      // subscription wraps it in params.result.
      const envelope = msg.params?.envelope ?? msg.params?.result?.envelope;
      if (!envelope) return;
      this.ingest = this.ingest
        .then(() => this.store(envelope))
        .catch((err) => console.error("[signal] failed to store an incoming message:", err));
    }
  }

  private async store(envelope: RawEnvelope): Promise<void> {
    const parsed = parseEnvelope(this.account, envelope);
    if (!parsed) return;
    const m = parsed.message;
    if (parsed.kind === "edit" && (await db.applySignalEdit(m.account, m.threadKey, m.sender, parsed.targetSentAt, m.body))) {
      return;
    }
    const rec = await db.insertSignalMessage(m);
    if (rec) this.events.emit("message", rec);
  }

  /** One JSON-RPC call to signal-cli. */
  rpc<T>(
    method: string,
    params: Record<string, unknown> = {},
    opts: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<T> {
    const child = this.child;
    if (!child || !child.stdin.writable) return Promise.reject(this.unavailable());
    if (opts.signal?.aborted) return Promise.reject(new Error("aborted"));
    const id = this.nextId++;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
    return new Promise<T>((resolve, reject) => {
      const settle = (err: Error | null, result?: unknown): void => {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        this.pending.delete(id);
        if (err) reject(err);
        else resolve(result as T);
      };
      const onAbort = (): void => settle(new Error("aborted"));
      const timer = setTimeout(
        () => settle(new Error(`signal-cli did not answer ${method} within ${Math.round(timeoutMs / 1000)}s`)),
        timeoutMs,
      );
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, { settle });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  // ---- directory -------------------------------------------------------------

  async listGroups(signal?: AbortSignal): Promise<SignalGroup[]> {
    const groups = await this.rpc<RawGroup[]>("listGroups", {}, { signal });
    return (groups ?? [])
      .filter((g) => g.isMember !== false)
      .map((g) => ({ id: g.id, name: g.name ?? null, memberCount: g.members?.length ?? 0 }));
  }

  async listContacts(signal?: AbortSignal): Promise<SignalContact[]> {
    const contacts = await this.rpc<RawContact[]>("listContacts", {}, { signal });
    return (contacts ?? []).map((c) => ({
      number: c.number ?? null,
      uuid: c.uuid ?? null,
      names: contactNames(c),
    }));
  }

  /**
   * Resolve what an agent passed as `thread`: a phone number, a uuid,
   * `group:<id>` (or a bare group id), or the exact name of a contact, group
   * or stored thread. Names must match one thread only.
   */
  async resolveThread(input: string, signal?: AbortSignal): Promise<ResolvedThread> {
    const raw = input.trim();
    if (!raw) throw new SignalThreadError("thread is required.");

    if (raw.startsWith("group:")) {
      const groupId = raw.slice("group:".length);
      return { threadKey: raw, name: null, target: { groupId } };
    }
    const number = normalizeNumber(raw);
    if (number) {
      const known = await db.signalThreadKeyForNumber(this.account, number);
      return { threadKey: known ?? number, name: null, target: { recipient: number } };
    }
    if (UUID.test(raw)) {
      return { threadKey: raw.toLowerCase(), name: null, target: { recipient: raw.toLowerCase() } };
    }

    // A name, or a bare group id. Gather every thread it could mean.
    const candidates = new Map<string, ResolvedThread>();
    const add = (t: ResolvedThread): void => {
      if (!candidates.has(t.threadKey)) candidates.set(t.threadKey, t);
    };
    for (const t of await db.signalThreadsNamed(this.account, raw)) {
      add({
        threadKey: t.threadKey,
        name: t.name,
        target: t.groupId ? { groupId: t.groupId } : { recipient: t.threadKey },
      });
    }
    const lower = raw.toLowerCase();
    let lookupError: Error | null = null;
    try {
      for (const g of await this.listGroups(signal)) {
        if (g.id === raw || g.name?.toLowerCase() === lower) {
          add({ threadKey: `group:${g.id}`, name: g.name, target: { groupId: g.id } });
        }
      }
      for (const c of await this.listContacts(signal)) {
        const recipient = c.number ?? c.uuid;
        if (!recipient || !c.names.some((n) => n.toLowerCase() === lower)) continue;
        const key = c.uuid ?? (await db.signalThreadKeyForNumber(this.account, recipient)) ?? recipient;
        add({ threadKey: key, name: c.names[0] ?? null, target: { recipient } });
      }
    } catch (err) {
      lookupError = err as Error;
    }

    const found = [...candidates.values()];
    if (found.length === 1) return found[0]!;
    if (found.length > 1) {
      const list = found.map((t) => `${t.threadKey} (${t.name ?? "unnamed"})`).join(", ");
      throw new SignalThreadError(`"${raw}" matches ${found.length} threads: ${list}. Pass one of those ids instead.`);
    }
    if (lookupError) throw lookupError;
    throw new SignalThreadError(
      `No Signal thread matches "${raw}". Pass a phone number in international format (+15551234567), ` +
        "a uuid, a group id (group:…), or the exact name of a contact or group — signal_threads lists them.",
    );
  }

  // ---- messaging -------------------------------------------------------------

  async send(
    threadInput: string,
    input: { message: string; replyTo?: number; attachments?: string[] },
    signal?: AbortSignal,
  ): Promise<SendResult> {
    const thread = await this.resolveThread(threadInput, signal);
    const params: Record<string, unknown> = { message: input.message };
    if ("groupId" in thread.target) params.groupId = thread.target.groupId;
    else params.recipient = [thread.target.recipient];
    if (input.attachments?.length) params.attachments = input.attachments;

    let quote: SignalQuote | null = null;
    if (input.replyTo != null) {
      const target = await db.findSignalMessage(this.account, thread.threadKey, input.replyTo);
      if (!target) {
        throw new SignalThreadError(
          `No message with timestamp ${input.replyTo} in this thread — reply_to takes a timestamp shown by signal_read.`,
        );
      }
      const author = target.direction === "out" ? this.account : (target.senderNumber ?? target.sender);
      params.quoteTimestamp = target.sentAt;
      params.quoteAuthor = author;
      params.quoteMessage = target.body;
      quote = { id: target.sentAt, author, text: target.body };
    }

    // Hold incoming messages back until this one is stored. A reply can reach
    // fastcar before the send response does (a group member answers while
    // signal-cli is still sending to the rest), and stored first it would get
    // the lower id — ordered before the message it answers, and invisible to
    // waitForReply, whose baseline is this message's id.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    this.ingest = this.ingest.then(() => gate);
    try {
      return await this.sendAndStore(thread, params, input, quote, signal);
    } finally {
      release();
    }
  }

  private async sendAndStore(
    thread: ResolvedThread,
    params: Record<string, unknown>,
    input: { message: string; attachments?: string[] },
    quote: SignalQuote | null,
    signal?: AbortSignal,
  ): Promise<SendResult> {
    const res = await this.rpc<{ timestamp: number; results?: RawSendResult[] }>("send", params, {
      signal,
      timeoutMs: SEND_TIMEOUT_MS,
    });
    const results = res.results ?? [];
    const failures = results
      .filter((r) => r.type && r.type !== "SUCCESS")
      .map((r) => ({
        recipient: r.recipientAddress?.number ?? r.recipientAddress?.uuid ?? r.recipientAddress?.username ?? "?",
        type: r.type!,
      }));
    // signal-cli reports no per-recipient results for Note to Self.
    const delivered = results.length ? results.length - failures.length : 1;

    // Key a direct thread by the uuid Signal just told us, so the replies —
    // which arrive carrying the sender's uuid — land in the same thread.
    let resolved = thread;
    let peerNumber: string | null = null;
    if ("recipient" in thread.target) {
      const addr = results[0]?.recipientAddress;
      peerNumber = addr?.number ?? normalizeNumber(thread.target.recipient);
      if (addr?.uuid && thread.threadKey !== addr.uuid) {
        resolved = { ...thread, threadKey: addr.uuid };
      }
    }

    if (delivered > 0) {
      const rec = await db.insertSignalMessage({
        account: this.account,
        threadKey: resolved.threadKey,
        groupId: "groupId" in thread.target ? thread.target.groupId : null,
        threadName: null,
        peerNumber,
        direction: "out",
        sender: this.account,
        senderNumber: this.account,
        senderName: null,
        sentAt: res.timestamp,
        body: input.message,
        attachments: (input.attachments ?? []).map((p) => ({
          id: null,
          contentType: null,
          filename: path.basename(p),
          size: null,
        })),
        quote,
        reaction: null,
      });
      if (rec) this.events.emit("message", rec);
    }
    return { thread: resolved, timestamp: res.timestamp, delivered, failures };
  }

  async read(
    threadInput: string,
    opts: { limit: number; waitSeconds?: number },
    signal?: AbortSignal,
  ): Promise<ReadResult> {
    const thread = await this.resolveThread(threadInput, signal);
    let wait: ReadResult["wait"] = null;
    if (opts.waitSeconds && opts.waitSeconds > 0) {
      const started = Date.now();
      const baseline = await db.signalReplyBaseline(this.account, thread.threadKey);
      const outcome = await this.waitForReply(thread.threadKey, baseline, opts.waitSeconds * 1000, signal);
      wait = { outcome, seconds: Math.round((Date.now() - started) / 1000) };
    }
    const messages = await db.listSignalMessages(this.account, thread.threadKey, opts.limit);
    if (messages.length) {
      await db.markSignalSeen(this.account, thread.threadKey, messages[0]!.id, messages.at(-1)!.id);
    }
    return { thread, messages, wait };
  }

  /**
   * Resolve once the thread holds an incoming message newer than `baseline`.
   * Subscribes before checking the table, so a reply stored between the two
   * is caught by one or the other.
   */
  waitForReply(threadKey: string, baseline: number, timeoutMs: number, signal?: AbortSignal): Promise<WaitOutcome> {
    return new Promise<WaitOutcome>((resolve) => {
      let done = false;
      const finish = (outcome: WaitOutcome): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        unsubscribe();
        signal?.removeEventListener("abort", onAbort);
        resolve(outcome);
      };
      const onAbort = (): void => finish("aborted");
      const timer = setTimeout(() => finish("timeout"), timeoutMs);
      const unsubscribe = this.onMessage((m) => {
        if (m.threadKey === threadKey && m.direction === "in" && m.id > baseline) finish("replied");
      });
      if (signal?.aborted) return finish("aborted");
      signal?.addEventListener("abort", onAbort, { once: true });
      db.hasSignalReplyAfter(this.account, threadKey, baseline).then(
        (has) => has && finish("replied"),
        () => {},
      );
    });
  }

  listThreads(limit: number): Promise<db.SignalThreadSummary[]> {
    return db.listSignalThreads(this.account, limit);
  }
}

function contactNames(c: RawContact): string[] {
  const join = (a?: string | null, b?: string | null): string => [a, b].filter(Boolean).join(" ").trim();
  return [
    c.name ?? "",
    c.nickName ?? "",
    join(c.givenName, c.familyName),
    join(c.profile?.givenName, c.profile?.familyName),
  ].filter((n, i, all) => n && all.indexOf(n) === i);
}

function rpcErrorText(err: { code?: number; message?: string; data?: unknown }): string {
  const base = `signal-cli: ${err.message ?? "request failed"}`;
  // A failed send carries the per-recipient results in data.response.
  const results = (err.data as { response?: { results?: RawSendResult[] } } | null)?.response?.results;
  if (!results?.length) return base;
  const detail = results
    .map((r) => `${r.recipientAddress?.number ?? r.recipientAddress?.uuid ?? "?"}: ${r.type ?? "?"}`)
    .join(", ");
  return `${base} (${detail})`;
}
