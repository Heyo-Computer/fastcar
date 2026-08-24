import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { InstallMcpRequest, McpServerStatus, McpToolInfo, McpTransport } from "@fastcar/shared";
import type { Config } from "../config.js";
import {
  deleteMcpServer,
  getMcpServerByName,
  listMcpServers,
  registerMcpServer,
  updateMcpServerTools,
  type McpServerRecord,
} from "../db/mcpServers.js";
import { decryptMap, encryptMap } from "./secrets.js";
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
          this.servers.set(record.name, { record, conn: null, connecting: null, status: "stopped" });
        }
      })();
    }
    return this.loaded;
  }

  async shutdown(): Promise<void> {
    for (const state of this.servers.values()) await this.disconnect(state);
  }

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
      status: s.status,
      error: s.error,
      tools: s.conn?.tools ?? r.tools,
      createdAt: r.createdAt,
    };
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

  /** One line per server for the conductor's system prompt; "" when none. */
  async promptSummary(): Promise<string> {
    const statuses = await this.statuses();
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
    if (state.conn) return Promise.resolve(state.conn);
    if (state.connecting) return state.connecting;
    state.connecting = this.openConnection(state)
      .then((conn) => {
        state.conn = conn;
        state.status = "connected";
        state.error = undefined;
        mcpEvents.emit("changed");
        return conn;
      })
      .catch((err) => {
        state.status = "error";
        state.error = err instanceof Error ? err.message : String(err);
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
    const stderrTail: string[] = [];
    let transport: Transport;
    if (r.transport === "http") {
      if (!r.url) throw new Error(`MCP server "${r.name}" has no url`);
      const headers = this.headersOf(r);
      transport = new StreamableHTTPClientTransport(new URL(r.url), {
        requestInit: Object.keys(headers).length ? { headers } : undefined,
      });
    } else {
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
    const transport: McpTransport =
      req.transport ?? (/^https?:\/\//.test(source) && !/github\.com/.test(source) && !/\.git$/.test(source) ? "http" : "stdio");

    const name = validName(req.name?.trim() || (transport === "http" ? new URL(source).hostname : deriveMcpName(source, req.subpath)));
    if (this.servers.has(name)) {
      throw new Error(`An MCP server named "${name}" is already installed. Remove it first or pick another name.`);
    }

    let record: McpServerRecord;
    if (transport === "http") {
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
          tools: [],
          createdAt: new Date().toISOString(),
        };
      } catch (err) {
        fs.rmSync(root, { recursive: true, force: true });
        throw err;
      }
    }

    // Connect before registering: a server that cannot answer tools/list is not installed.
    const state: ServerState = { record, conn: null, connecting: null, status: "stopped" };
    try {
      log("connecting");
      await this.connect(state);
    } catch (err) {
      if (record.transport === "stdio") fs.rmSync(path.join(this.cfg.mcpDir, name), { recursive: true, force: true });
      throw err;
    }
    record.tools = state.conn?.tools ?? [];
    state.record = await registerMcpServer(record);
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
