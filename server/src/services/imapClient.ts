import { ImapFlow } from "imapflow";

/**
 * The slice of IMAP the inbox sync needs, so EmailService can be driven by a
 * fake in tests. The real implementation is a thin wrapper over imapflow.
 */
export interface ImapConnSettings {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
}

export interface ImapClient {
  connect(): Promise<void>;
  /** Select a mailbox read-only. */
  open(mailbox: string): Promise<{ uidValidity: bigint; uidNext: number }>;
  /** UIDs of messages received on or after `since`, ascending. */
  searchSince(since: Date): Promise<number[]>;
  /**
   * Raw RFC 822 source of each message with a UID in the set. Uses
   * BODY.PEEK, so the server's \Seen flag is left alone.
   */
  fetchRaw(uids: number[] | string): AsyncIterable<{ uid: number; source: Buffer }>;
  /**
   * Resolve when the mailbox reports new mail, after `timeoutMs`, or on
   * abort. Rejects if the connection drops.
   */
  waitForNew(timeoutMs: number, signal: AbortSignal): Promise<void>;
  close(): Promise<void>;
}

export type ImapFactory = (s: ImapConnSettings) => ImapClient;

export const imapflowFactory: ImapFactory = (s) => {
  const client = new ImapFlow({
    host: s.host,
    port: s.port,
    secure: s.secure,
    auth: { user: s.username, pass: s.password },
    logger: false,
    // imapflow IDLEs on its own when the connection is quiet and emits
    // `exists` when mail arrives; restart IDLE every few minutes so a server
    // that silently drops idle connections is noticed.
    maxIdleTime: 5 * 60_000,
  });
  let closed: Error | null = null;
  const closeWaiters = new Set<(err: Error) => void>();
  const newWaiters = new Set<() => void>();
  client.on("close", () => {
    closed = new Error("IMAP connection closed");
    for (const w of closeWaiters) w(closed);
  });
  client.on("error", (err: Error) => {
    closed = err;
    for (const w of closeWaiters) w(err);
  });
  client.on("exists", () => {
    for (const w of newWaiters) w();
  });

  return {
    connect: () => client.connect(),
    async open(mailbox) {
      const box = await client.mailboxOpen(mailbox, { readOnly: true });
      return { uidValidity: box.uidValidity, uidNext: box.uidNext };
    },
    async searchSince(since) {
      const uids = await client.search({ since }, { uid: true });
      return (uids || []).sort((a, b) => a - b);
    },
    async *fetchRaw(uids) {
      const range = Array.isArray(uids) ? uids.join(",") : uids;
      if (!range) return;
      for await (const msg of client.fetch(range, { uid: true, source: true }, { uid: true })) {
        if (msg.source) yield { uid: msg.uid, source: msg.source };
      }
    },
    waitForNew(timeoutMs, signal) {
      if (closed) return Promise.reject(closed);
      return new Promise<void>((resolve, reject) => {
        const done = (): void => {
          clearTimeout(timer);
          newWaiters.delete(onNew);
          closeWaiters.delete(onClose);
          signal.removeEventListener("abort", onNew);
        };
        const onNew = (): void => {
          done();
          resolve();
        };
        const onClose = (err: Error): void => {
          done();
          reject(err);
        };
        const timer = setTimeout(onNew, timeoutMs);
        newWaiters.add(onNew);
        closeWaiters.add(onClose);
        signal.addEventListener("abort", onNew, { once: true });
      });
    },
    async close() {
      if (closed) return;
      await client.logout().catch(() => client.close());
    },
  };
};
