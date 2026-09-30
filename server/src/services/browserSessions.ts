import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import type { Config } from "../config.js";
import { CHROMIUM_ARGS, findChromium } from "./chromium.js";

/**
 * Long-lived headless browser sessions for the browser_* tools.
 *
 * browser_check launches a fresh Chromium per call, which is right for
 * checking a page and useless for a site that takes several steps: a login, a
 * multi-page quote form, a search then a result. Here each fastcar thread gets
 * its own BrowserContext — cookies, storage and open tabs — that survives
 * between tool calls, inside one shared Chromium process.
 *
 * Contexts close after `idleMs` without use, the least recently used one is
 * evicted past `maxSessions`, and Chromium itself exits when no context is
 * left, so an idle VM does not carry a browser's memory around.
 *
 * Pi can run a turn's tool calls in parallel; withSession() serialises the
 * calls of one thread so two actions never interleave on the same page.
 */

export interface BrowserSession {
  readonly threadId: string;
  readonly context: BrowserContext;
  /** Open tabs, in the order they opened. */
  pages: Page[];
  /** The tab actions apply to. */
  active: Page | null;
  /** Dialogs, downloads, new tabs and page errors since the last drain. */
  events: string[];
  /** Screenshots and downloads for this thread. */
  readonly dir: string;
  lastUsed: number;
}

export interface BrowserSessionsOptions {
  idleMs?: number;
  maxSessions?: number;
  maxPages?: number;
}

const MAX_EVENTS = 50;

export class BrowserSessions {
  private browser: Promise<Browser> | null = null;
  private readonly sessions = new Map<string, Promise<BrowserSession>>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly idleTimers = new Map<string, NodeJS.Timeout>();
  private readonly idleMs: number;
  private readonly maxSessions: number;
  readonly maxPages: number;

  constructor(
    private readonly cfg: Config,
    opts: BrowserSessionsOptions = {},
  ) {
    this.idleMs = opts.idleMs ?? 10 * 60_000;
    this.maxSessions = opts.maxSessions ?? 3;
    this.maxPages = opts.maxPages ?? 6;
  }

  /** Whether a Chromium binary exists to drive. */
  available(): boolean {
    return findChromium() !== undefined;
  }

  has(threadId: string): boolean {
    return this.sessions.has(threadId);
  }

  /** Run `fn` against the thread's session, creating it on first use. */
  withSession<T>(threadId: string, fn: (s: BrowserSession) => Promise<T>): Promise<T> {
    const prev = this.locks.get(threadId) ?? Promise.resolve();
    const run = prev.catch(() => {}).then(async () => {
      this.clearIdle(threadId);
      const session = await this.getOrCreate(threadId);
      session.lastUsed = Date.now();
      try {
        return await fn(session);
      } finally {
        session.lastUsed = Date.now();
        this.armIdle(threadId);
      }
    });
    const tail = run.catch(() => {});
    this.locks.set(threadId, tail);
    void tail.then(() => {
      if (this.locks.get(threadId) === tail) this.locks.delete(threadId);
    });
    return run;
  }

  /** Close a thread's session (its tabs, cookies and storage). */
  async close(threadId: string): Promise<boolean> {
    this.clearIdle(threadId);
    const pending = this.sessions.get(threadId);
    if (!pending) return false;
    this.sessions.delete(threadId);
    const session = await pending.catch(() => null);
    await session?.context.close().catch(() => {});
    await this.maybeCloseBrowser();
    return true;
  }

  async shutdown(): Promise<void> {
    for (const id of [...this.sessions.keys()]) await this.close(id);
    const browser = await this.browser?.catch(() => null);
    this.browser = null;
    await browser?.close().catch(() => {});
  }

  // ---- internals ---------------------------------------------------------------

  private getOrCreate(threadId: string): Promise<BrowserSession> {
    const existing = this.sessions.get(threadId);
    if (existing) return existing;
    const created = this.create(threadId);
    this.sessions.set(threadId, created);
    created.catch(() => {
      if (this.sessions.get(threadId) === created) this.sessions.delete(threadId);
    });
    return created;
  }

  private async create(threadId: string): Promise<BrowserSession> {
    await this.evictIfFull(threadId);
    const browser = await this.getBrowser();
    // Headless Chromium announces itself as "HeadlessChrome" in its user
    // agent, which many sites answer with a block page. Present as the same
    // Chrome version, headed.
    const version = browser.version();
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      locale: "en-US",
      userAgent: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`,
      acceptDownloads: true,
    });
    context.setDefaultTimeout(10_000);
    context.setDefaultNavigationTimeout(30_000);
    const dir = path.join(this.cfg.dataDir, "browser", threadId);
    const session: BrowserSession = { threadId, context, pages: [], active: null, events: [], dir, lastUsed: Date.now() };
    context.on("page", (page) => this.adopt(session, page));
    context.on("close", () => {
      if (this.sessions.get(threadId)) {
        this.sessions.delete(threadId);
        this.clearIdle(threadId);
      }
    });
    return session;
  }

  /** Track a tab: new tabs (popups, target=_blank) become the active one. */
  private adopt(session: BrowserSession, page: Page): void {
    const note = (line: string): void => {
      session.events.push(line);
      if (session.events.length > MAX_EVENTS) session.events.splice(0, session.events.length - MAX_EVENTS);
    };
    if (session.pages.length >= this.maxPages) {
      note(`[tab] a new tab was blocked: ${this.maxPages} tabs are already open (browser_tabs close one)`);
      void page.close().catch(() => {});
      return;
    }
    const opener = session.active;
    session.pages.push(page);
    session.active = page;
    if (opener) note(`[tab] a new tab opened and is now active (tab ${session.pages.length - 1})`);

    page.on("close", () => {
      session.pages = session.pages.filter((p) => p !== page);
      if (session.active === page) session.active = session.pages.at(-1) ?? null;
    });
    page.on("dialog", (dialog) => {
      note(`[dialog] ${dialog.type()}: "${dialog.message()}" — accepted`);
      void dialog.accept().catch(() => {});
    });
    page.on("pageerror", (err) => note(`[pageerror] ${err.message}`));
    page.on("download", (download) => {
      const file = path.join(session.dir, "downloads", `${Date.now()}-${download.suggestedFilename()}`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      download.saveAs(file).then(
        () => note(`[download] saved ${file}`),
        (err: Error) => note(`[download] ${download.suggestedFilename()} failed: ${err.message}`),
      );
    });
  }

  private async evictIfFull(incoming: string): Promise<void> {
    while (this.sessions.size >= this.maxSessions) {
      let oldest: { id: string; at: number } | null = null;
      for (const [id, pending] of this.sessions) {
        if (id === incoming) continue;
        const s = await pending.catch(() => null);
        const at = s?.lastUsed ?? 0;
        if (!oldest || at < oldest.at) oldest = { id, at };
      }
      if (!oldest) return;
      await this.close(oldest.id);
    }
  }

  private getBrowser(): Promise<Browser> {
    if (this.browser) return this.browser;
    const executablePath = findChromium();
    if (!executablePath) {
      return Promise.reject(
        new Error("No Chromium binary found. Install chromium, or set FASTCAR_CHROMIUM_PATH to a Chrome/Chromium executable."),
      );
    }
    const launching = chromium.launch({ executablePath, args: CHROMIUM_ARGS });
    this.browser = launching;
    launching.then(
      (b) =>
        b.on("disconnected", () => {
          if (this.browser === launching) this.browser = null;
          this.sessions.clear();
          for (const id of [...this.idleTimers.keys()]) this.clearIdle(id);
        }),
      () => {
        if (this.browser === launching) this.browser = null;
      },
    );
    return launching;
  }

  private async maybeCloseBrowser(): Promise<void> {
    if (this.sessions.size > 0 || !this.browser) return;
    const browser = await this.browser.catch(() => null);
    // A session may have been opened while we waited.
    if (this.sessions.size > 0) return;
    this.browser = null;
    await browser?.close().catch(() => {});
  }

  private armIdle(threadId: string): void {
    this.clearIdle(threadId);
    const t = setTimeout(() => void this.close(threadId), this.idleMs);
    t.unref();
    this.idleTimers.set(threadId, t);
  }

  private clearIdle(threadId: string): void {
    const t = this.idleTimers.get(threadId);
    if (t) clearTimeout(t);
    this.idleTimers.delete(threadId);
  }
}
