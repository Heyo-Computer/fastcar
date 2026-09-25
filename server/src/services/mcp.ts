import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport, SseError } from "@modelcontextprotocol/sdk/client/sse.js";
import { auth, UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { InstallMcpRequest, McpServerStatus, McpToolInfo, McpTransport } from "@fastcar/shared";
import type { Config } from "../config.js";
import {
  deleteMcpServer,
  getMcpServerByName,
  listMcpServers,
  registerMcpServer,
  updateMcpServerOAuth,
  updateMcpServerTools,
  updateMcpServerTransport,
  type McpServerRecord,
} from "../db/mcpServers.js";
import { decryptMap, decryptSecret, encryptMap, encryptSecret } from "./secrets.js";
import {
  McpOAuthProvider,
  OAUTH_CALLBACK_PATH,
  OAUTH_CLIENT_METADATA_PATH,
  clientMetadataUrlFor,
  type OAuthState,
} from "./mcpOAuth.js";
import { runGit } from "./git.js";

/**
 * MCP servers the agents can install and call.
 *
 * A server is installed from a git source (typically a GitHub tree URL such as
 * https://github.com/org/repo/tree/main/mcp) into `<mcpDir>/<name>/repo`, built
 * with the project's own package manager, and launched over stdio on demand;
 * or registered as a remote Streamable-HTTP endpoint. The registry lives in
 * Postgres (db/mcpServers.ts) so installs survive restarts; env vars and
 * headers are encrypted at rest.
 *
 * Tools are exposed to the agents generically (mcp_list_tools / mcp_call in
 * tools/mcp.ts) rather than as one Pi tool per MCP tool: Pi fixes a session's
 * tool registry at creation, and the generic pair works for every thread and
 * subagent the moment a server is installed.
 */

/** Emits "changed" whenever the set of servers or a connection state changes. */
export const mcpEvents = new EventEmitter();

const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
const CONNECT_TIMEOUT_MS = 60_000;
const CALL_TIMEOUT_MS = 120_000;
const STDERR_TAIL_LINES = 40;

export interface ParsedSource {
  /** What to hand to `git clone` (URL or local path). */
  gitUrl: string;
  ref?: string;
  subpath?: string;
}

/**
 * Turn the URL a user pastes into clone instructions.
 *
 * GitHub "tree" and "blob" URLs carry the ref and the directory; a "blob" URL
 * points at a file, so its directory is used. Anything else is passed to git
 * as-is (https, ssh, or a local path — the tests use the latter). A ref that
 * contains slashes cannot be told apart from the path in a tree URL; pass
 * `ref`/`subpath` explicitly for those.
 */
export function parseMcpSource(source: string): ParsedSource {
  const trimmed = source.trim().replace(/\/+$/, "");
  const m = /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/#?]+)(?:\/(tree|blob)\/([^/]+)(?:\/(.*))?)?$/.exec(
    trimmed,
  );
  if (!m) return { gitUrl: trimmed };
  const [, owner, repoRaw = "", kind, ref, rest] = m;
  const repo = repoRaw.replace(/\.git$/, "");
  const gitUrl = `https://github.com/${owner}/${repo}.git`;
  if (!kind) return { gitUrl };
  let subpath = rest ? rest.replace(/^\/+|\/+$/g, "") : "";
  if (kind === "blob" && subpath) subpath = path.posix.dirname(subpath);
  if (subpath === ".") subpath = "";
  return { gitUrl, ref, subpath: subpath || undefined };
}

export function deriveMcpName(source: string, subpath: string | undefined): string {
  const parsed = parseMcpSource(source);
  const sub = subpath ?? parsed.subpath;
  const fromSub = sub ? sub.split("/").filter(Boolean).pop() : undefined;
  // "mcp" is what every repo calls its server directory; qualify it by the repo.
  const repoBase = parsed.gitUrl.replace(/\/+$/, "").split("/").pop()?.replace(/\.git$/, "") ?? "mcp";
  const raw = !fromSub ? repoBase : /^mcp(-server)?$/i.test(fromSub) ? `${repoBase}-${fromSub}` : fromSub;
  return raw.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/^[-.]+/, "") || "mcp";
}

function validName(name: string): string {
  const n = name.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(n)) {
    throw new Error(`Invalid MCP server name "${name}": use letters, digits, ., _ or - (max 64).`);
  }
  return n;
}

function run(
  cmd: string,
  args: string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      {
        cwd,
        timeout: INSTALL_TIMEOUT_MS,
        maxBuffer: 20 * 1024 * 1024,
        signal,
        env: { ...process.env, CI: "1", NPM_CONFIG_FUND: "false", NPM_CONFIG_AUDIT: "false" },
      },
      (err, stdout, stderr) => {
        if (err) {
          const tail = (stderr || stdout || err.message).trim().split("\n").slice(-15).join("\n");
          reject(new Error(`${cmd} ${args.join(" ")} failed:\n${tail}`));
        } else resolve({ stdout, stderr });
      },
    );
  });
}

function commandExists(cmd: string): boolean {
  const dirs = (process.env.PATH ?? "").split(path.delimiter);
  return dirs.some((d) => d && fs.existsSync(path.join(d, cmd)));
}

interface PackageJson {
  name?: string;
  bin?: string | Record<string, string>;
  main?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

/**
 * Work out how to build and launch the project in `dir`, unless the caller
 * gave an explicit command. Node projects are fully automatic; Python projects
 * are synced with uv when it is on PATH but need an explicit command, since
 * there is no convention for the entry point.
 */
async function prepareProject(
  dir: string,
  explicit: { command?: string; args?: string[] },
  signal: AbortSignal | undefined,
  log: (line: string) => void,
): Promise<{ command: string; args: string[] }> {
  const pkgPath = path.join(dir, "package.json");
  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as PackageJson;
    const hasDeps =
      Object.keys(pkg.dependencies ?? {}).length + Object.keys(pkg.devDependencies ?? {}).length > 0;
    if (hasDeps) {
      log("npm install");
      await run("npm", ["install", "--no-audit", "--no-fund"], dir, signal);
    }
    if (pkg.scripts?.build) {
      log("npm run build");
      await run("npm", ["run", "build"], dir, signal);
    }
    if (explicit.command) return { command: explicit.command, args: explicit.args ?? [] };
    const bin =
      typeof pkg.bin === "string"
        ? pkg.bin
        : pkg.bin
          ? (pkg.name && pkg.bin[pkg.name]) || Object.values(pkg.bin)[0]
          : undefined;
    const candidates = [bin, pkg.main, "dist/index.js", "build/index.js", "index.js", "server.js"].filter(
      (c): c is string => !!c,
    );
    const entry = candidates.find((c) => fs.existsSync(path.join(dir, c)));
    if (!entry) {
      throw new Error(
        `Could not find the server entry point in ${dir} (tried ${candidates.join(", ")}). Pass command/args explicitly.`,
      );
    }
    return { command: "node", args: [path.join(dir, entry), ...(explicit.args ?? [])] };
  }

  const pyproject = fs.existsSync(path.join(dir, "pyproject.toml"));
  const requirements = fs.existsSync(path.join(dir, "requirements.txt"));
  if (pyproject || requirements) {
    if (commandExists("uv")) {
      if (pyproject) {
        log("uv sync");
        await run("uv", ["sync"], dir, signal);
      } else {
        log("uv venv && uv pip install -r requirements.txt");
        await run("uv", ["venv"], dir, signal);
        await run("uv", ["pip", "install", "-r", "requirements.txt"], dir, signal);
      }
    } else {
      log("uv not found; skipping dependency install");
    }
    if (explicit.command) return { command: explicit.command, args: explicit.args ?? [] };
    throw new Error(
      `${dir} is a Python project; pass command/args explicitly (e.g. command "uv", args ["run", "server.py"]).`,
    );
  }

  if (explicit.command) return { command: explicit.command, args: explicit.args ?? [] };
  throw new Error(
    `No package.json or pyproject.toml in ${dir}; pass command/args explicitly to launch the server.`,
  );
}

interface Connection {
  client: Client;
  transport: Transport;
  tools: McpToolInfo[];
  stderrTail: string[];
}

interface ServerState {
  record: McpServerRecord;
  conn: Connection | null;
  connecting: Promise<Connection> | null;
  status: McpServerStatus["status"];
  error?: string;
  /** Present while the server is waiting on an OAuth sign-in. */
  authorizationUrl?: string;
  /** False until the row exists — i.e. during a first install's sign-in. */
  registered: boolean;
}

/**
 * The server wants the user to sign in. Carries the URL to send them to and
 * the OAuth state the callback will come back with.
 */
export class McpAuthorizationRequired extends Error {
  constructor(
    readonly authorizationUrl: string,
    readonly oauthState: string,
  ) {
    super("this MCP server requires signing in");
  }
}

/** An OAuth sign-in that has been started and not yet finished. */
interface PendingAuth {
  state: ServerState;
  provider: McpOAuthProvider;
  startedAt: number;
}

/** A sign-in nobody finished is dropped after this long. */
const PENDING_AUTH_TTL_MS = 30 * 60_000;

/** Unwrap an SDK transport error to its HTTP status, if it has one. */
function httpStatusOf(err: unknown): number | undefined {
  let e = err as { cause?: unknown } | undefined;
  for (let i = 0; e && i < 4; i++) {
    if ((e instanceof StreamableHTTPError || e instanceof SseError) && typeof e.code === "number") {
      return e.code;
    }
    e = e.cause as typeof e;
  }
  return undefined;
}

function isUnauthorized(err: unknown): boolean {
  if (err instanceof UnauthorizedError) return true;
  const status = httpStatusOf(err);
  return status === 401 || status === 403;
}

function toToolInfo(t: {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: unknown;
}): McpToolInfo {
  return {
    name: t.name,
    description: t.description,
    inputSchema: (t.inputSchema as Record<string, unknown> | undefined) ?? undefined,
    annotations: (t.annotations as Record<string, unknown> | undefined) ?? undefined,
  };
}

/** Render a tools/call result as text for the model. */
export function renderToolResult(result: { content?: unknown; structuredContent?: unknown }): string {
  const parts: string[] = [];
  const content = Array.isArray(result.content) ? result.content : [];
  for (const item of content as Array<Record<string, unknown>>) {
    switch (item.type) {
      case "text":
        parts.push(String(item.text ?? ""));
        break;
      case "image":
        parts.push(`[image ${String(item.mimeType ?? "")}, ${String(item.data ?? "").length} base64 chars]`);
        break;
      case "audio":
        parts.push(`[audio ${String(item.mimeType ?? "")}]`);
        break;
      case "resource": {
        const res = (item.resource ?? {}) as Record<string, unknown>;
        parts.push(
          typeof res.text === "string"
            ? `[resource ${String(res.uri ?? "")}]\n${res.text}`
            : `[resource ${String(res.uri ?? "")} (${String(res.mimeType ?? "binary")})]`,
        );
        break;
      }
      case "resource_link":
        parts.push(`[resource link ${String(item.uri ?? "")}]`);
        break;
      default:
        parts.push(JSON.stringify(item));
    }
  }
  if (!parts.length && result.structuredContent !== undefined) {
    parts.push(JSON.stringify(result.structuredContent, null, 2));
  }
  return parts.join("\n") || "(empty result)";
}

/**
 * Which transport a bare install source implies. An http(s) URL that is not a
 * git host is a deployed server; everything else is cloned and run locally.
 * `http` here means "remote — negotiate": openRemote falls back to SSE.
 */
export function guessTransport(source: string): McpTransport {
  if (!/^https?:\/\//.test(source)) return "stdio";
  if (/\.git\/?$/.test(source)) return "stdio";
  if (/^https?:\/\/(www\.)?(github\.com|gitlab\.com|bitbucket\.org)\//.test(source)) return "stdio";
  return /\/sse\/?$/.test(new URL(source).pathname) ? "sse" : "http";
}

export class McpManager {
  private readonly servers = new Map<string, ServerState>();
  private loaded: Promise<void> | null = null;

  constructor(private readonly cfg: Config) {}

  /** Load the registry; connect in the background so boot never waits on a server. */
  async start(): Promise<void> {
    await this.load();
    for (const state of this.servers.values()) {
      void this.connect(state).catch(() => {
        // status/error already recorded on the state
      });
    }
  }

  private load(): Promise<void> {
    if (!this.loaded) {
      this.loaded = (async () => {
        for (const record of await listMcpServers()) {
          this.servers.set(record.name, {
            record,
            conn: null,
            connecting: null,
            status: "stopped",
            registered: true,
          });
        }
      })();
    }
    return this.loaded;
  }

  /**
   * Stop every server, including ones still connecting.
   *
   * start() connects in the background, so a shutdown that only closed
   * `state.conn` missed any connection still in flight: it landed afterwards
   * and was never closed — a spawned stdio process left running, or an SSE
   * EventSource that auto-reconnects forever once its server goes away. That
   * is exactly the window a rollout's SIGTERM tends to hit. So refuse new
   * connections, let the in-flight ones settle, then close everything.
   */
  async shutdown(): Promise<void> {
    this.stopped = true;
    await Promise.allSettled(
      [...this.servers.values()].map((s) => s.connecting).filter((p): p is Promise<Connection> => Boolean(p)),
    );
    for (const state of this.servers.values()) await this.disconnect(state);
  }

  private stopped = false;

  // ---------------------------------------------------------------- queries

  async statuses(): Promise<McpServerStatus[]> {
    await this.load();
    return [...this.servers.values()]
      .sort((a, b) => a.record.name.localeCompare(b.record.name))
      .map((s) => this.status(s));
  }

  private status(s: ServerState): McpServerStatus {
    const r = s.record;
    return {
      name: r.name,
      source: r.source,
      transport: r.transport,
      path: r.path ?? undefined,
      url: r.url ?? undefined,
      command: r.command ?? undefined,
      args: r.args,
      envKeys: Object.keys(this.envOf(r)),
      headerKeys: Object.keys(this.headersOf(r)),
      auth: this.authOf(r),
      status: s.status,
      error: s.error,
      ...(s.status === "needs_auth" && s.authorizationUrl
        ? { authorizationUrl: s.authorizationUrl }
        : {}),
      tools: s.conn?.tools ?? r.tools,
      createdAt: r.createdAt,
    };
  }

  private authOf(r: McpServerRecord): McpServerStatus["auth"] {
    if (r.transport === "stdio") return "none";
    if (r.oauthEnc) return "oauth";
    return Object.keys(this.headersOf(r)).length ? "headers" : "none";
  }

  private envOf(r: McpServerRecord): Record<string, string> {
    try {
      return decryptMap(r.envEnc, this.cfg);
    } catch {
      return {};
    }
  }

  private headersOf(r: McpServerRecord): Record<string, string> {
    try {
      return decryptMap(r.headersEnc, this.cfg);
    } catch {
      return {};
    }
  }

  /**
   * One line per server for an agent's system prompt; "" when none.
   *
   * `only` restricts the summary to the servers an agent may reach. Naming a
   * server it cannot call would just invite a refused mcp_call — the subset is
   * enforced for real in tools/mcp.ts, this keeps the prompt honest about it.
   */
  async promptSummary(only?: readonly string[]): Promise<string> {
    const all = await this.statuses();
    const allow = only ? new Set(only) : null;
    const statuses = allow ? all.filter((s) => allow.has(s.name)) : all;
    if (!statuses.length) return "";
    return statuses
      .map((s) => {
        const names = s.tools.map((t) => t.name);
        const shown = names.slice(0, 25).join(", ") + (names.length > 25 ? `, … (${names.length} total)` : "");
        const state = s.status === "connected" ? "" : ` [${s.status}${s.error ? `: ${s.error}` : ""}]`;
        return `- **${s.name}**${state} — ${names.length} tool(s): ${shown || "(none advertised yet)"}`;
      })
      .join("\n");
  }

  /** True when the server marks the tool read-only (safe to call in plan mode). */
  async isReadOnlyTool(server: string, tool: string): Promise<boolean> {
    await this.load();
    const s = this.servers.get(server);
    const tools = s?.conn?.tools ?? s?.record.tools ?? [];
    const t = tools.find((x) => x.name === tool);
    return t?.annotations?.readOnlyHint === true;
  }

  async listTools(server: string): Promise<McpToolInfo[]> {
    const state = await this.require(server);
    const conn = await this.connect(state);
    return conn.tools;
  }

  async callTool(
    server: string,
    tool: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<string> {
    const state = await this.require(server);
    const conn = await this.connect(state);
    let result;
    try {
      result = await conn.client.callTool({ name: tool, arguments: args }, undefined, {
        signal,
        timeout: CALL_TIMEOUT_MS,
      });
    } catch (err) {
      const stderr = conn.stderrTail.slice(-5).join("\n");
      throw new Error(
        `${server}/${tool} failed: ${err instanceof Error ? err.message : String(err)}${stderr ? `\nserver stderr:\n${stderr}` : ""}`,
      );
    }
    const text = renderToolResult(result as { content?: unknown; structuredContent?: unknown });
    if ((result as { isError?: boolean }).isError) throw new Error(`${server}/${tool} returned an error:\n${text}`);
    return text;
  }

  private async require(name: string): Promise<ServerState> {
    await this.load();
    const state = this.servers.get(name);
    if (!state) {
      const names = [...this.servers.keys()];
      throw new Error(`No MCP server named "${name}". Installed: ${names.join(", ") || "(none)"}`);
    }
    return state;
  }

  // ---------------------------------------------------------------- connections

  private connect(state: ServerState): Promise<Connection> {
    if (this.stopped) return Promise.reject(new Error("the MCP manager is shutting down"));
    if (state.conn) return Promise.resolve(state.conn);
    if (state.connecting) return state.connecting;
    state.connecting = this.openConnection(state)
      .then((conn) => {
        state.conn = conn;
        state.status = "connected";
        state.error = undefined;
        state.authorizationUrl = undefined;
        mcpEvents.emit("changed");
        return conn;
      })
      .catch((err) => {
        if (err instanceof McpAuthorizationRequired) {
          // Not a failure: the server is fine, it wants a person to sign in.
          state.status = "needs_auth";
          state.authorizationUrl = err.authorizationUrl;
          state.error = undefined;
        } else {
          state.status = "error";
          state.error = err instanceof Error ? err.message : String(err);
        }
        mcpEvents.emit("changed");
        throw err;
      })
      .finally(() => {
        state.connecting = null;
      });
    return state.connecting;
  }

  private async openConnection(state: ServerState): Promise<Connection> {
    const r = state.record;
    if (r.transport !== "stdio") return this.openRemote(state);

    const stderrTail: string[] = [];
    let transport: Transport;
    {
      if (!r.command) throw new Error(`MCP server "${r.name}" has no launch command`);
      if (r.path && !fs.existsSync(r.path)) {
        throw new Error(`MCP server "${r.name}" is registered but missing on disk at ${r.path}`);
      }
      const stdio = new StdioClientTransport({
        command: r.command,
        args: r.args,
        cwd: r.path ?? undefined,
        env: { ...getDefaultEnvironment(), ...this.envOf(r) },
        stderr: "pipe",
      });
      stdio.stderr?.on("data", (chunk: Buffer) => {
        for (const line of chunk.toString().split("\n")) {
          if (!line.trim()) continue;
          stderrTail.push(line);
          if (stderrTail.length > STDERR_TAIL_LINES) stderrTail.shift();
        }
      });
      transport = stdio;
    }

    const client = new Client({ name: "fastcar", version: "0.1.0" }, { capabilities: {} });
    const conn: Connection = { client, transport, tools: [], stderrTail };
    transport.onclose = () => {
      if (state.conn === conn) {
        state.conn = null;
        state.status = "stopped";
        mcpEvents.emit("changed");
      }
    };
    transport.onerror = (err) => {
      stderrTail.push(`transport error: ${err.message}`);
    };

    try {
      await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
      const listed = await client.listTools(undefined, { timeout: CONNECT_TIMEOUT_MS });
      conn.tools = listed.tools.map(toToolInfo);
    } catch (err) {
      await transport.close().catch(() => {});
      const detail = stderrTail.slice(-8).join("\n");
      throw new Error(
        `could not connect to MCP server "${r.name}": ${err instanceof Error ? err.message : String(err)}${detail ? `\nserver stderr:\n${detail}` : ""}`,
      );
    }
    // Cache the tool list so the prompt can name tools before the next connect.
    if (JSON.stringify(conn.tools) !== JSON.stringify(r.tools)) {
      r.tools = conn.tools;
      await updateMcpServerTools(r.name, conn.tools).catch(() => {});
    }
    return conn;
  }

  // ---------------------------------------------------------------- remote servers

  /** Where the authorization server sends the browser back to. */
  private get callbackUrl(): string {
    return `${this.cfg.publicUrl}${OAUTH_CALLBACK_PATH}`;
  }

  /**
   * An OAuth provider for this server, backed by its encrypted blob. For a
   * server still mid-install the blob lives only on the in-memory record, so
   * an abandoned sign-in leaves no row behind.
   */
  private oauthProviderFor(state: ServerState): McpOAuthProvider {
    const r = state.record;
    let data: OAuthState = {};
    if (r.oauthEnc) {
      try {
        data = JSON.parse(decryptSecret(r.oauthEnc, this.cfg)) as OAuthState;
      } catch {
        data = {};
      }
    }
    return new McpOAuthProvider(
      data,
      this.callbackUrl,
      async (next) => {
        r.oauthEnc = encryptSecret(JSON.stringify(next), this.cfg);
        if (state.registered) await updateMcpServerOAuth(r.name, r.oauthEnc).catch(() => {});
      },
      clientMetadataUrlFor(this.cfg.publicUrl),
    );
  }

  /**
   * The transports to try, in order. A URL ending in /sse is the legacy
   * transport by convention; otherwise try Streamable HTTP and, per the MCP
   * spec's backwards-compatibility rule, fall back to HTTP+SSE if the server
   * rejects it with a 4xx. Many SSE deployments serve the stream at a sibling
   * /sse path rather than the URL given, so that is tried too.
   */
  private remoteCandidates(r: McpServerRecord): Array<{ transport: "http" | "sse"; url: URL }> {
    const url = new URL(r.url!);
    if (r.transport === "sse" || /\/sse\/?$/.test(url.pathname)) return [{ transport: "sse", url }];
    const out: Array<{ transport: "http" | "sse"; url: URL }> = [
      { transport: "http", url },
      { transport: "sse", url },
    ];
    if (/\/mcp\/?$/.test(url.pathname)) {
      const sibling = new URL(url);
      sibling.pathname = url.pathname.replace(/\/mcp\/?$/, "/sse");
      out.push({ transport: "sse", url: sibling });
    }
    return out;
  }

  private makeRemoteTransport(
    kind: "http" | "sse",
    url: URL,
    headers: Record<string, string>,
    provider: McpOAuthProvider,
    watchedFetch: typeof fetch,
  ): Transport {
    const requestInit = Object.keys(headers).length ? { headers } : undefined;
    // A static Authorization header and OAuth are alternatives: when the user
    // supplied one, do not let a 401 from a bad token start a sign-in flow.
    const authProvider = headers.Authorization || headers.authorization ? undefined : provider;
    if (kind === "http") {
      return new StreamableHTTPClientTransport(url, { requestInit, authProvider, fetch: watchedFetch });
    }
    return new SSEClientTransport(url, {
      requestInit,
      authProvider,
      fetch: watchedFetch,
      // The EventSource leg has its own fetch. Without merging the headers in
      // here, a bearer token reaches the POSTs but not the stream and the
      // server 401s it.
      eventSourceInit: {
        fetch: (u, init) =>
          watchedFetch(u, { ...init, headers: { ...(init?.headers as object), ...headers } }),
      },
    });
  }

  /**
   * A fetch that notes whether the MCP endpoint itself answered 401/403.
   *
   * When OAuth discovery fails, the SDK walks the whole chain — protected
   * resource metadata, authorization server metadata, then a guessed
   * /register at the server root — and surfaces whatever the *last* request
   * produced: typically a ServerError with an empty message and no status.
   * The error shape cannot tell us the server wanted credentials; the wire can.
   * Discovery and token requests are excluded, since their 401s say nothing
   * about whether the endpoint needs auth.
   */
  private watchingFetch(): { fetch: typeof fetch; sawUnauthorized: () => boolean } {
    let unauthorized = false;
    const oauthPath = /\/\.well-known\/|\/(register|token|authorize)\/?$/;
    return {
      fetch: async (input, init) => {
        const res = await fetch(input, init);
        if (res.status === 401 || res.status === 403) {
          const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
          if (!oauthPath.test(new URL(href).pathname)) unauthorized = true;
        }
        return res;
      },
      sawUnauthorized: () => unauthorized,
    };
  }

  private async openRemote(state: ServerState): Promise<Connection> {
    const r = state.record;
    if (!r.url) throw new Error(`MCP server "${r.name}" has no url`);
    const headers = this.headersOf(r);
    const provider = this.oauthProviderFor(state);
    const tried: string[] = [];

    for (const candidate of this.remoteCandidates(r)) {
      const watch = this.watchingFetch();
      const transport = this.makeRemoteTransport(
        candidate.transport,
        candidate.url,
        headers,
        provider,
        watch.fetch,
      );
      const client = new Client({ name: "fastcar", version: "0.1.0" }, { capabilities: {} });
      const conn: Connection = { client, transport, tools: [], stderrTail: [] };
      transport.onclose = () => {
        if (state.conn === conn) {
          state.conn = null;
          state.status = "stopped";
          mcpEvents.emit("changed");
        }
      };
      transport.onerror = (err) => {
        conn.stderrTail.push(`transport error: ${err.message}`);
        if (conn.stderrTail.length > STDERR_TAIL_LINES) conn.stderrTail.shift();
      };

      try {
        await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
        const listed = await client.listTools(undefined, { timeout: CONNECT_TIMEOUT_MS });
        conn.tools = listed.tools.map(toToolInfo);
      } catch (err) {
        await transport.close().catch(() => {});

        // The server wants a sign-in: surface the URL rather than an error.
        if (provider.pendingAuthorizationUrl) {
          const pending = new McpAuthorizationRequired(
            provider.pendingAuthorizationUrl.toString(),
            provider.oauthState,
          );
          this.pendingAuth.set(provider.oauthState, { state, provider, startedAt: Date.now() });
          // Remember which transport got as far as asking, so the retry after
          // sign-in does not renegotiate from scratch.
          r.transport = candidate.transport;
          r.url = candidate.url.toString();
          throw pending;
        }
        if (watch.sawUnauthorized() || isUnauthorized(err)) {
          throw new Error(this.authErrorMessage(r, headers, err));
        }

        const status = httpStatusOf(err);
        tried.push(`${candidate.transport} ${candidate.url.pathname} → ${status ?? (err as Error).message}`);
        // Only a 4xx means "wrong transport or path, try the next". A 5xx, a
        // timeout or a refused connection would fail the same way on every
        // candidate, so report it now instead of three times.
        if (status !== undefined && status >= 400 && status < 500) continue;
        throw new Error(
          `could not connect to MCP server "${r.name}" at ${candidate.url}: ${(err as Error).message}`,
        );
      }

      // Connected. Record what worked so reconnects skip the negotiation.
      if (candidate.transport !== r.transport || candidate.url.toString() !== r.url) {
        r.transport = candidate.transport;
        r.url = candidate.url.toString();
        if (state.registered) {
          await updateMcpServerTransport(r.name, r.transport).catch(() => {});
        }
      }
      if (JSON.stringify(conn.tools) !== JSON.stringify(r.tools)) {
        r.tools = conn.tools;
        if (state.registered) await updateMcpServerTools(r.name, conn.tools).catch(() => {});
      }
      return conn;
    }

    throw new Error(
      `could not connect to MCP server "${r.name}": it is not answering as an MCP server over ` +
        `Streamable HTTP or HTTP+SSE. Tried: ${tried.join("; ")}. Check the URL — ` +
        `deployed servers usually live at a path like /mcp or /sse.`,
    );
  }

  /**
   * A 401 from a server whose OAuth fastcar cannot use, or that rejected a token.
   * The SDK's own message here is a raw response body; say what to do instead.
   */
  private authErrorMessage(r: McpServerRecord, headers: Record<string, string>, err: unknown): string {
    const raw = err instanceof Error ? err.message.split("\n")[0] : String(err);
    const detail = raw?.trim() || "the server answered 401 Unauthorized";
    if (headers.Authorization || headers.authorization) {
      return `MCP server "${r.name}" rejected the Authorization header (${detail}). The token may be wrong, expired, or lack the required scope.`;
    }
    // It does offer OAuth — just not dynamic registration. The SDK only falls
    // back to /register when it has no usable CIMD url, so that is the cause.
    if (/dynamic client registration/i.test(detail)) {
      return (
        `MCP server "${r.name}" uses OAuth with URL-based client ids (Client ID Metadata Documents) ` +
        `rather than dynamic client registration. fastcar supports that only when FASTCAR_PUBLIC_URL ` +
        `is an https address the provider can reach (currently ${this.cfg.publicUrl}), with ` +
        `${OAUTH_CLIENT_METADATA_PATH} publicly accessible. Alternatively, reinstall it with an ` +
        `Authorization header if the provider issues API keys.`
      );
    }
    return (
      `MCP server "${r.name}" requires authentication and does not advertise OAuth sign-in. ` +
      `Reinstall it with an Authorization header — e.g. headers: {"Authorization": "Bearer <token>"} — ` +
      `using the API key or token from the provider's documentation. (${detail})`
    );
  }

  // ---------------------------------------------------------------- OAuth sign-in

  private readonly pendingAuth = new Map<string, PendingAuth>();

  private prunePendingAuth(): void {
    const cutoff = Date.now() - PENDING_AUTH_TTL_MS;
    for (const [key, p] of this.pendingAuth) if (p.startedAt < cutoff) this.pendingAuth.delete(key);
  }

  /**
   * Finish a sign-in: exchange the authorization code for tokens, connect, and
   * — for a first install — register the server now that it has answered
   * tools/list. Called from the OAuth callback route.
   */
  async completeAuthorization(oauthState: string, code: string): Promise<McpServerStatus> {
    this.prunePendingAuth();
    const pending = this.pendingAuth.get(oauthState);
    if (!pending) {
      throw new Error("This sign-in link has expired or was already used. Start the connection again.");
    }
    this.pendingAuth.delete(oauthState);
    const { state, provider } = pending;
    const r = state.record;

    const result = await auth(provider, { serverUrl: r.url!, authorizationCode: code });
    if (result !== "AUTHORIZED") throw new Error("the authorization server did not issue tokens");

    state.conn = null;
    state.status = "stopped";
    const conn = await this.connect(state);

    if (!state.registered) {
      if (this.servers.has(r.name)) {
        throw new Error(`An MCP server named "${r.name}" was installed while this sign-in was open.`);
      }
      r.tools = conn.tools;
      state.record = await registerMcpServer(r);
      state.registered = true;
      this.servers.set(r.name, state);
      mcpEvents.emit("changed");
    }
    return this.status(state);
  }

  /**
   * Start (or restart) a sign-in for an installed server — its refresh token
   * was revoked, say. Returns the URL to send the user to.
   */
  async startAuthorization(name: string): Promise<McpServerStatus> {
    const state = await this.require(name);
    if (state.record.transport === "stdio") throw new Error(`"${name}" is a local server; it has no sign-in`);
    // Drop any tokens so the SDK goes to the authorization server rather than
    // retrying the credential that just failed.
    await this.oauthProviderFor(state).invalidateCredentials("tokens");
    await this.disconnect(state);
    try {
      await this.connect(state);
    } catch (err) {
      if (!(err instanceof McpAuthorizationRequired)) throw err;
    }
    return this.status(state);
  }

  private async disconnect(state: ServerState): Promise<void> {
    const conn = state.conn;
    state.conn = null;
    state.status = "stopped";
    if (conn) await conn.transport.close().catch(() => {});
  }

  // ---------------------------------------------------------------- install / remove

  /**
   * Install and connect a server. Nothing is registered until the server has
   * answered tools/list, so a broken install never leaves a dead entry behind.
   */
  async install(
    req: InstallMcpRequest,
    opts: { signal?: AbortSignal; log?: (line: string) => void } = {},
  ): Promise<McpServerStatus> {
    await this.load();
    const log = opts.log ?? (() => {});
    const source = req.source.trim();
    if (!source) throw new Error("source is required");
    const transport: McpTransport = req.transport ?? guessTransport(source);
    const remote = transport !== "stdio";

    const name = validName(req.name?.trim() || (remote ? new URL(source).hostname : deriveMcpName(source, req.subpath)));
    if (this.servers.has(name)) {
      throw new Error(`An MCP server named "${name}" is already installed. Remove it first or pick another name.`);
    }

    let record: McpServerRecord;
    if (remote) {
      const url = new URL(source).toString();
      record = {
        id: "",
        name,
        source,
        transport,
        url,
        path: null,
        command: null,
        args: [],
        envEnc: "",
        headersEnc: encryptMap(req.headers ?? {}, this.cfg),
        oauthEnc: "",
        tools: [],
        createdAt: new Date().toISOString(),
      };
    } else {
      const parsed = parseMcpSource(source);
      const ref = req.ref?.trim() || parsed.ref;
      const subpath = (req.subpath?.trim() || parsed.subpath || "").replace(/^\/+|\/+$/g, "");
      if (subpath.split("/").includes("..")) throw new Error("subpath may not contain '..'");
      const root = path.join(this.cfg.mcpDir, name);
      if (fs.existsSync(root)) throw new Error(`Install directory already exists: ${root}`);
      fs.mkdirSync(this.cfg.mcpDir, { recursive: true });
      const repoDir = path.join(root, "repo");
      try {
        log(`git clone ${parsed.gitUrl}${ref ? ` @ ${ref}` : ""}`);
        await this.clone(parsed.gitUrl, ref, repoDir, opts.signal);
        const projectDir = subpath ? path.join(repoDir, subpath) : repoDir;
        if (!fs.existsSync(projectDir)) {
          throw new Error(`Subdirectory "${subpath}" does not exist in the repository.`);
        }
        const launch = await prepareProject(projectDir, { command: req.command, args: req.args }, opts.signal, log);
        record = {
          id: "",
          name,
          source,
          transport,
          url: null,
          path: projectDir,
          command: launch.command,
          args: launch.args,
          envEnc: encryptMap(req.env ?? {}, this.cfg),
          headersEnc: "",
          oauthEnc: "",
          tools: [],
          createdAt: new Date().toISOString(),
        };
      } catch (err) {
        fs.rmSync(root, { recursive: true, force: true });
        throw err;
      }
    }

    // Connect before registering: a server that cannot answer tools/list is not installed.
    const state: ServerState = {
      record,
      conn: null,
      connecting: null,
      status: "stopped",
      registered: false,
    };
    try {
      log(remote ? `connecting to ${record.url}` : "connecting");
      await this.connect(state);
    } catch (err) {
      if (err instanceof McpAuthorizationRequired) {
        // Still not registered: the row is written by completeAuthorization
        // once the signed-in server answers tools/list. Hand back the URL.
        log("sign-in required");
        return this.status(state);
      }
      if (record.transport === "stdio") fs.rmSync(path.join(this.cfg.mcpDir, name), { recursive: true, force: true });
      throw err;
    }
    record.tools = state.conn?.tools ?? [];
    state.record = await registerMcpServer(state.record);
    state.registered = true;
    this.servers.set(name, state);
    mcpEvents.emit("changed");
    return this.status(state);
  }

  private async clone(gitUrl: string, ref: string | undefined, dest: string, signal?: AbortSignal): Promise<void> {
    if (!ref) {
      await runGit(["clone", "--depth", "1", gitUrl, dest], undefined, signal);
      return;
    }
    try {
      // Branches and tags: a shallow clone at the ref.
      await runGit(["clone", "--depth", "1", "--branch", ref, gitUrl, dest], undefined, signal);
    } catch {
      // Commits: no shallow clone by ref, so fetch everything and check it out.
      fs.rmSync(dest, { recursive: true, force: true });
      await runGit(["clone", gitUrl, dest], undefined, signal);
      await runGit(["checkout", ref], dest, signal);
    }
  }

  /** Stop the server, drop it from the registry and delete its install directory. */
  async remove(name: string): Promise<{ name: string; path: string | null }> {
    const state = await this.require(name);
    await this.disconnect(state);
    this.servers.delete(name);
    await deleteMcpServer(name);
    const root = path.join(this.cfg.mcpDir, name);
    // Only ever delete inside the managed directory.
    const rel = path.relative(path.resolve(this.cfg.mcpDir), path.resolve(root));
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
    mcpEvents.emit("changed");
    return { name, path: state.record.path };
  }

  /** Drop the live connection so the next call restarts the server (e.g. after a rebuild). */
  async restart(name: string): Promise<McpServerStatus> {
    const state = await this.require(name);
    await this.disconnect(state);
    await this.connect(state);
    return this.status(state);
  }
}

// Keep the DB accessor import used even when only the manager is exported.
void getMcpServerByName;
