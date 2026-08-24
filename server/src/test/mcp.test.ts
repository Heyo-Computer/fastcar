import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config.js";
import { migrate } from "../db/migrate.js";
import { closePool } from "../db/pool.js";
import { getMcpServerByName } from "../db/mcpServers.js";
import { runGit } from "../services/git.js";
import { McpManager, deriveMcpName, parseMcpSource, renderToolResult } from "../services/mcp.js";
import { decryptMap } from "../services/secrets.js";

// Exercises the MCP feature end to end without the network: a git repository
// is built in a temp dir with the dependency-free echo server under mcp/ (the
// same layout as https://github.com/Heyo-Computer/heyo-public/tree/main/mcp),
// installed through McpManager, called, and removed.

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://fastcar:fastcar@127.0.0.1:5432/fastcar";
const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "mcp-echo");
const NAME = `mcp-test-${process.pid}`;

describe("parseMcpSource", () => {
  it("reads ref and subdirectory from a GitHub tree URL", () => {
    assert.deepEqual(parseMcpSource("https://github.com/Heyo-Computer/heyo-public/tree/main/mcp"), {
      gitUrl: "https://github.com/Heyo-Computer/heyo-public.git",
      ref: "main",
      subpath: "mcp",
    });
  });
  it("uses the directory of a blob URL", () => {
    assert.deepEqual(parseMcpSource("https://github.com/o/r/blob/v1.2/servers/x/src/index.ts"), {
      gitUrl: "https://github.com/o/r.git",
      ref: "v1.2",
      subpath: "servers/x/src",
    });
  });
  it("treats a bare repository URL as the root on the default branch", () => {
    assert.deepEqual(parseMcpSource("https://github.com/o/r.git/"), { gitUrl: "https://github.com/o/r.git" });
    assert.equal(parseMcpSource("git@github.com:o/r.git").gitUrl, "git@github.com:o/r.git");
    assert.equal(parseMcpSource("/tmp/some/repo").gitUrl, "/tmp/some/repo");
  });
  it("names a generic mcp/ directory after its repository", () => {
    assert.equal(deriveMcpName("https://github.com/Heyo-Computer/heyo-public/tree/main/mcp", undefined), "heyo-public-mcp");
    assert.equal(deriveMcpName("https://github.com/o/r/tree/main/servers/weather", undefined), "weather");
    assert.equal(deriveMcpName("https://github.com/o/weather-mcp", undefined), "weather-mcp");
  });
});

describe("renderToolResult", () => {
  it("joins text blocks and summarizes binary ones", () => {
    const text = renderToolResult({
      content: [
        { type: "text", text: "hello" },
        { type: "image", data: "abcd", mimeType: "image/png" },
        { type: "resource", resource: { uri: "file:///x", text: "body" } },
      ],
    });
    assert.equal(text, "hello\n[image image/png, 4 base64 chars]\n[resource file:///x]\nbody");
  });
  it("falls back to structured content", () => {
    assert.equal(renderToolResult({ content: [], structuredContent: { a: 1 } }), JSON.stringify({ a: 1 }, null, 2));
  });
});

describe("McpManager install / call / remove", () => {
  let cfg: ReturnType<typeof loadConfig>;
  let manager: McpManager;
  let tmp: string;
  let sourceRepo: string;

  before(async () => {
    process.env.FASTCAR_MOCK = "1";
    process.env.DATABASE_URL = DATABASE_URL;
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fastcar-mcp-"));
    process.env.FASTCAR_MCP_DIR = path.join(tmp, "installs");
    cfg = loadConfig();
    await migrate();

    // A git repository whose mcp/ directory holds the echo server.
    sourceRepo = path.join(tmp, "source");
    fs.mkdirSync(path.join(sourceRepo, "mcp"), { recursive: true });
    for (const f of fs.readdirSync(FIXTURE)) {
      fs.copyFileSync(path.join(FIXTURE, f), path.join(sourceRepo, "mcp", f));
    }
    await runGit(["init", "-q", "-b", "main"], sourceRepo);
    await runGit(["add", "-A"], sourceRepo);
    await runGit(
      ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-q", "-m", "echo server"],
      sourceRepo,
    );

    manager = new McpManager(cfg);
    await manager.start();
  });

  after(async () => {
    await manager.remove(NAME).catch(() => {});
    await manager.shutdown();
    await closePool();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("installs a stdio server from a git source + subpath, builds nothing, and lists its tools", async () => {
    const log: string[] = [];
    const status = await manager.install(
      { source: sourceRepo, subpath: "mcp", name: NAME, env: { ECHO_GREETING: "hello" } },
      { log: (l) => log.push(l) },
    );
    assert.equal(status.status, "connected");
    assert.equal(status.transport, "stdio");
    assert.equal(status.command, "node");
    assert.ok(status.args?.[0]?.endsWith(path.join("mcp", "server.js")), `entry from package.json bin: ${status.args}`);
    assert.deepEqual(status.tools.map((t) => t.name).sort(), ["echo", "shout"]);
    assert.deepEqual(status.envKeys, ["ECHO_GREETING"]);
    assert.ok(log.some((l) => l.startsWith("git clone")), "reports progress");
    assert.ok(!log.some((l) => l.includes("npm install")), "no dependencies → no npm install");
    assert.ok(fs.existsSync(path.join(cfg.mcpDir, NAME, "repo", "mcp", "server.js")));
  });

  it("persists the registry with env encrypted at rest", async () => {
    const rec = await getMcpServerByName(NAME);
    assert.ok(rec, "registered in Postgres");
    assert.ok(!rec.envEnc.includes("hello"), "env value is not stored in clear text");
    assert.deepEqual(decryptMap(rec.envEnc, cfg), { ECHO_GREETING: "hello" });
    assert.equal(rec.tools.length, 2, "tool list cached for the prompt");
  });

  it("calls a tool and returns its text", async () => {
    assert.equal(await manager.callTool(NAME, "echo", { text: "ping" }), "ping");
    assert.equal(await manager.callTool(NAME, "shout", { text: "ping" }), "PING");
  });

  it("surfaces tool errors as thrown errors", async () => {
    await assert.rejects(manager.callTool(NAME, "nope", {}), /nope/);
  });

  it("honours readOnlyHint for the plan-mode gate", async () => {
    assert.equal(await manager.isReadOnlyTool(NAME, "echo"), true);
    assert.equal(await manager.isReadOnlyTool(NAME, "shout"), false);
    assert.equal(await manager.isReadOnlyTool("missing", "echo"), false);
  });

  it("names installed servers in the prompt summary", async () => {
    const summary = await manager.promptSummary();
    assert.match(summary, new RegExp(`\\*\\*${NAME}\\*\\* — 2 tool\\(s\\): echo, shout`));
  });

  it("refuses a duplicate name and unknown servers", async () => {
    await assert.rejects(manager.install({ source: sourceRepo, subpath: "mcp", name: NAME }), /already installed/);
    await assert.rejects(manager.callTool("missing", "echo", {}), /No MCP server named "missing"/);
  });

  it("restarts a server whose process died", async () => {
    await manager.restart(NAME);
    assert.equal(await manager.callTool(NAME, "echo", { text: "again" }), "again");
  });

  it("removes the server, its registry row and its install directory", async () => {
    const r = await manager.remove(NAME);
    assert.equal(r.name, NAME);
    assert.equal(await getMcpServerByName(NAME), null);
    assert.ok(!fs.existsSync(path.join(cfg.mcpDir, NAME)));
    assert.deepEqual(await manager.statuses(), []);
  });

  it("does not register a server that fails to start", async () => {
    await assert.rejects(
      manager.install({ source: sourceRepo, subpath: "mcp", name: `${NAME}-bad`, command: "node", args: ["-e", "process.exit(3)"] }),
      /could not connect/,
    );
    assert.equal(await getMcpServerByName(`${NAME}-bad`), null);
    assert.ok(!fs.existsSync(path.join(cfg.mcpDir, `${NAME}-bad`)), "install dir cleaned up");
  });
});
