/**
 * Deployed MCP servers: connecting to one someone else runs, over whichever
 * remote transport it speaks, with whichever credentials it wants.
 *
 * Before this, a remote install only worked for a server that spoke
 * Streamable HTTP and needed either no auth or a header the UI had no way to
 * supply. Legacy HTTP+SSE servers failed outright, a 401 surfaced as a raw
 * response body, and OAuth servers — most hosted MCP servers — could not be
 * connected at all. The fixture in fixtures/remoteMcp.ts plays all of those
 * roles, including a small spec-shaped OAuth authorization server.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../config.js";
import { migrate } from "../db/migrate.js";
import { closePool, getPool } from "../db/pool.js";
import { getMcpServerByName } from "../db/mcpServers.js";
import { guessTransport, McpManager } from "../services/mcp.js";
import Fastify from "fastify";
import { registerRoutes } from "../http/routes.js";
import { ArtifactService } from "../services/artifacts.js";
import { EmailService } from "../services/emailService.js";
import { startRemoteMcp, type RemoteMcp } from "./fixtures/remoteMcp.js";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://fastcar:fastcar@127.0.0.1:5433/fastcar";
const RUN = Date.now().toString(36);
let seq = 0;
const uniq = (label: string) => `remote-${label}-${RUN}-${++seq}`;

describe("guessTransport", () => {
  it("treats a deployed endpoint as remote and a repository as local", () => {
    assert.equal(guessTransport("https://mcp.example.com/mcp"), "http");
    assert.equal(guessTransport("https://mcp.example.com/sse"), "sse");
    assert.equal(guessTransport("https://mcp.example.com/sse/"), "sse");
    assert.equal(guessTransport("https://github.com/org/repo/tree/main/mcp"), "stdio");
    assert.equal(guessTransport("https://gitlab.com/org/repo"), "stdio");
    assert.equal(guessTransport("https://git.example.com/org/repo.git"), "stdio");
    assert.equal(guessTransport("/home/me/servers/echo"), "stdio");
  });
});

describe("remote MCP servers", () => {
  let manager: McpManager;
  let tmp: string;
  const servers: RemoteMcp[] = [];
  const installed: string[] = [];
  const start = async (opts: Parameters<typeof startRemoteMcp>[0] = {}) => {
    const s = await startRemoteMcp(opts);
    servers.push(s);
    return s;
  };
  const install = async (req: Parameters<McpManager["install"]>[0]) => {
    installed.push(req.name!);
    return manager.install(req);
  };

  before(async () => {
    process.env.FASTCAR_MOCK = "1";
    process.env.DATABASE_URL = DATABASE_URL;
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fastcar-mcp-remote-"));
    process.env.FASTCAR_MCP_DIR = path.join(tmp, "installs");
    process.env.FASTCAR_PUBLIC_URL = "http://fastcar.test";
    await migrate();
    manager = new McpManager(loadConfig());
    await manager.start();
  });

  after(async () => {
    for (const n of installed) await manager.remove(n).catch(() => {});
    await manager.shutdown();
    for (const s of servers) await s.close();
    await getPool().query("DELETE FROM mcp_servers WHERE name LIKE $1", [`remote-%-${RUN}-%`]);
    await closePool();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------- transports

  it("connects to a Streamable HTTP server and calls its tool", async () => {
    const srv = await start();
    const name = uniq("streamable");
    const status = await install({ source: `${srv.url}/mcp`, name });
    assert.equal(status.status, "connected");
    assert.equal(status.transport, "http");
    assert.equal(status.auth, "none");
    assert.equal(await manager.callTool(name, "echo", { text: "a" }), "remote echo: a");
    // Nothing on disk: a deployed server is not cloned.
    assert.equal(status.path, undefined);
  });

  it("connects to a legacy HTTP+SSE server given its /sse URL", async () => {
    const srv = await start({ transports: ["sse"] });
    const name = uniq("sse");
    const status = await install({ source: `${srv.url}/sse`, name });
    assert.equal(status.transport, "sse");
    assert.equal(await manager.callTool(name, "echo", { text: "b" }), "remote echo: b");
  });

  it("falls back to SSE when an SSE-only server is given its /mcp URL", async () => {
    const srv = await start({ transports: ["sse"] });
    const name = uniq("fallback");
    const status = await install({ source: `${srv.url}/mcp`, name });
    assert.equal(status.transport, "sse", "negotiated down from Streamable HTTP");
    assert.equal(await manager.callTool(name, "echo", { text: "c" }), "remote echo: c");

    // The negotiated transport is persisted, so a restart reconnects directly
    // instead of renegotiating — and the 'sse' value must survive the round
    // trip through the database (the old reader coerced it to 'stdio').
    const row = await getMcpServerByName(name);
    assert.equal(row?.transport, "sse");
    assert.match(row!.url!, /\/sse$/);

    const fresh = new McpManager(loadConfig());
    await fresh.start();
    assert.equal(await fresh.callTool(name, "echo", { text: "after restart" }), "remote echo: after restart");
    await fresh.shutdown();
  });

  it("reports a non-MCP endpoint as such rather than a transport error", async () => {
    const srv = await start();
    await assert.rejects(
      () => install({ source: `${srv.url}/not-mcp`, name: uniq("wrongpath") }),
      /not answering as an MCP server/,
    );
  });

  // ---------------------------------------------------------------- API keys

  it("sends a bearer token on every request, over Streamable HTTP", async () => {
    const srv = await start({ bearer: "k-1" });
    const name = uniq("bearer");
    const status = await install({
      source: `${srv.url}/mcp`,
      name,
      headers: { Authorization: "Bearer k-1" },
    });
    assert.equal(status.auth, "headers");
    assert.deepEqual(status.headerKeys, ["Authorization"], "header names shown, values never");
    assert.equal(await manager.callTool(name, "echo", { text: "d" }), "remote echo: d");
  });

  it("sends a bearer token on the SSE stream as well as the POSTs", async () => {
    // EventSource has its own fetch: without merging headers into it the token
    // reaches the POSTs but not the stream, and the server 401s the stream.
    const srv = await start({ transports: ["sse"], bearer: "k-2" });
    const name = uniq("ssebearer");
    await install({ source: `${srv.url}/sse`, name, headers: { Authorization: "Bearer k-2" } });
    assert.equal(await manager.callTool(name, "echo", { text: "e" }), "remote echo: e");
    const streamGets = srv.requests.filter((r) => r.method === "GET" && r.path === "/sse");
    assert.ok(streamGets.every((r) => r.auth === "Bearer k-2"), "the stream carried the token");
  });

  it("explains a 401 from a server that needs a key it was not given", async () => {
    const srv = await start({ bearer: "k-3" });
    await assert.rejects(
      () => install({ source: `${srv.url}/mcp`, name: uniq("nokey") }),
      (e: Error) =>
        /requires authentication and does not advertise OAuth/.test(e.message) &&
        /Authorization/.test(e.message),
    );
  });

  it("explains a rejected key", async () => {
    const srv = await start({ bearer: "k-4" });
    await assert.rejects(
      () => install({ source: `${srv.url}/mcp`, name: uniq("badkey"), headers: { Authorization: "Bearer wrong" } }),
      /rejected the Authorization header/,
    );
  });

  it("does not leave a row behind when a remote install fails", async () => {
    const srv = await start({ bearer: "k-5" });
    const name = uniq("norow");
    await assert.rejects(() => install({ source: `${srv.url}/mcp`, name }));
    assert.equal(await getMcpServerByName(name), null);
  });

  // ---------------------------------------------------------------- OAuth

  /** Stand in for the user's browser: follow the sign-in URL to the callback. */
  async function signIn(authorizationUrl: string): Promise<{ state: string; code: string; callback: URL }> {
    const res = await fetch(authorizationUrl, { redirect: "manual" });
    assert.equal(res.status, 302, "the authorization server redirects back");
    const callback = new URL(res.headers.get("location")!);
    return { state: callback.searchParams.get("state")!, code: callback.searchParams.get("code")!, callback };
  }

  it("signs in to an OAuth server: pending until the callback, then registered", async () => {
    const srv = await start({ oauth: true });
    const name = uniq("oauth");

    const pending = await install({ source: `${srv.url}/mcp`, name });
    assert.equal(pending.status, "needs_auth");
    assert.equal(pending.auth, "oauth");
    assert.ok(pending.authorizationUrl);
    // The same rule as a local install: nothing registered until it answers
    // tools/list, so an abandoned sign-in leaves no row.
    assert.equal(await getMcpServerByName(name), null);
    assert.ok(!(await manager.statuses()).some((s) => s.name === name));

    const { state, code, callback } = await signIn(pending.authorizationUrl!);
    assert.equal(callback.origin + callback.pathname, "http://fastcar.test/api/mcp/oauth/callback");

    const done = await manager.completeAuthorization(state, code);
    assert.equal(done.status, "connected");
    assert.deepEqual(done.tools.map((t) => t.name), ["echo"]);
    assert.equal(await manager.callTool(name, "echo", { text: "f" }), "remote echo: f");

    // Registered now, with the credentials encrypted at rest.
    const row = await getMcpServerByName(name);
    assert.ok(row?.oauthEnc, "tokens persisted");
    assert.ok(!row!.oauthEnc.includes("access_token"), "and not in plaintext");
  });

  it("uses the stored tokens after a restart, with no new sign-in", async () => {
    const srv = await start({ oauth: true });
    const name = uniq("oauthrestart");
    const pending = await install({ source: `${srv.url}/mcp`, name });
    const { state, code } = await signIn(pending.authorizationUrl!);
    await manager.completeAuthorization(state, code);

    const fresh = new McpManager(loadConfig());
    await fresh.start();
    assert.equal(await fresh.callTool(name, "echo", { text: "g" }), "remote echo: g");
    await fresh.shutdown();
  });

  it("refuses a replayed or unknown callback", async () => {
    const srv = await start({ oauth: true });
    const name = uniq("oauthreplay");
    const pending = await install({ source: `${srv.url}/mcp`, name });
    const { state, code } = await signIn(pending.authorizationUrl!);
    await manager.completeAuthorization(state, code);

    await assert.rejects(() => manager.completeAuthorization(state, code), /expired or was already used/);
    await assert.rejects(() => manager.completeAuthorization("forged-state", "x"), /expired or was already used/);
  });

  it("asks for a fresh sign-in when the provider revokes access", async () => {
    const srv = await start({ oauth: true });
    const name = uniq("oauthrevoke");
    const pending = await install({ source: `${srv.url}/mcp`, name });
    const first = await signIn(pending.authorizationUrl!);
    await manager.completeAuthorization(first.state, first.code);

    srv.revokeAll();
    const again = await manager.startAuthorization(name);
    assert.equal(again.status, "needs_auth");
    assert.ok(again.authorizationUrl);

    const second = await signIn(again.authorizationUrl!);
    const back = await manager.completeAuthorization(second.state, second.code);
    assert.equal(back.status, "connected");
    assert.equal(await manager.callTool(name, "echo", { text: "h" }), "remote echo: h");
  });

  it("shutdown closes connections that were still being opened", async () => {
    // start() connects in the background. A shutdown that only closed
    // already-landed connections leaked the in-flight ones — found because
    // this very suite hung on exit, with orphaned SSE streams reconnecting.
    const srv = await start();
    const name = uniq("shutdown");
    await install({ source: `${srv.url}/mcp`, name });

    const fresh = new McpManager(loadConfig());
    await fresh.start(); // kicks off background connects, does not wait
    await fresh.shutdown(); // immediately, while they are in flight
    for (const s of await fresh.statuses()) {
      assert.notEqual(s.status, "connected", `${s.name} was left connected after shutdown`);
    }
    await assert.rejects(() => fresh.callTool(name, "echo", { text: "x" }), /shutting down/);
  });

  it("does not start OAuth when a static Authorization header was given", async () => {
    // A key and OAuth are alternatives. A 401 on a supplied key means the key
    // is wrong — sending the user off to sign in instead would be confusing.
    const srv = await start({ oauth: true });
    await assert.rejects(
      () => install({ source: `${srv.url}/mcp`, name: uniq("keyonoauth"), headers: { Authorization: "Bearer nope" } }),
      /rejected the Authorization header/,
    );
    assert.ok(!srv.requests.some((r) => r.path === "/register"), "no client registration attempted");
  });
});


describe("OAuth callback route", () => {
  let app: ReturnType<typeof Fastify>;
  let manager: McpManager;
  let srv: RemoteMcp;
  const name = uniq("route");

  before(async () => {
    process.env.FASTCAR_MOCK = "1";
    process.env.DATABASE_URL = DATABASE_URL;
    process.env.FASTCAR_PUBLIC_URL = "http://fastcar.test";
    // With an admin token set, every admin-gated route needs a bearer header —
    // which a browser redirect cannot send. The callback must still work.
    process.env.FASTCAR_ADMIN_TOKEN = "admin-secret";
    await migrate();
    const cfg = loadConfig();
    manager = new McpManager(cfg);
    await manager.start();
    srv = await startRemoteMcp({ oauth: true });
    app = Fastify();
    registerRoutes(app, cfg, { artifacts: new ArtifactService(cfg), email: new EmailService(cfg), mcp: manager });
    await app.ready();
  });

  after(async () => {
    delete process.env.FASTCAR_ADMIN_TOKEN;
    await manager.remove(name).catch(() => {});
    await manager.shutdown();
    await app.close();
    await srv.close();
  });

  it("finishes a sign-in without the admin token, as a browser redirect would", async () => {
    const pending = await manager.install({ source: `${srv.url}/mcp`, name });
    const res = await fetch(pending.authorizationUrl!, { redirect: "manual" });
    const callback = new URL(res.headers.get("location")!);

    const page = await app.inject({ method: "GET", url: callback.pathname + callback.search });
    assert.equal(page.statusCode, 200);
    assert.match(page.headers["content-type"] as string, /text\/html/);
    assert.match(page.body, /Connected to/);
    assert.equal((await manager.statuses()).find((s) => s.name === name)?.status, "connected");
  });

  it("shows a cancelled sign-in, and escapes what the provider sent", async () => {
    const page = await app.inject({
      method: "GET",
      url: `/api/mcp/oauth/callback?error=access_denied&error_description=${encodeURIComponent('<script>alert(1)</script>')}`,
    });
    assert.equal(page.statusCode, 400);
    assert.match(page.body, /Sign-in cancelled/);
    assert.ok(!page.body.includes("<script>alert(1)</script>"), "provider text is reflected, so it must be escaped");
    assert.match(page.body, /&lt;script&gt;/);
  });

  it("refuses a forged state", async () => {
    const page = await app.inject({ method: "GET", url: "/api/mcp/oauth/callback?code=x&state=forged" });
    assert.equal(page.statusCode, 400);
    assert.match(page.body, /expired or was already used/);
  });

  it("keeps re-authorization itself admin-gated", async () => {
    const res = await app.inject({ method: "POST", url: `/api/mcp/${name}/authorize` });
    assert.equal(res.statusCode, 403);
  });
});

/**
 * Client ID Metadata Documents (CIMD), as Loops' MCP server requires: its
 * authorization server has no /register, so fastcar's client_id is the https
 * URL of a document fastcar serves. The fixture resolves that URL through the
 * real route, so the document's shape is what is under test too.
 */
describe("OAuth with a URL-based client id (CIMD)", () => {
  let manager: McpManager;
  let app: ReturnType<typeof Fastify>;
  let srv: RemoteMcp;
  const names: string[] = [];
  const CLIENT_ID = "https://fastcar.test/api/mcp/oauth/client-metadata.json";

  before(async () => {
    process.env.FASTCAR_MOCK = "1";
    process.env.DATABASE_URL = DATABASE_URL;
    await migrate();
    const cfg = { ...loadConfig(), publicUrl: "https://fastcar.test" };
    manager = new McpManager(cfg);
    await manager.start();
    app = Fastify();
    registerRoutes(app, cfg, { artifacts: new ArtifactService(cfg), email: new EmailService(cfg), mcp: manager });
    await app.ready();
    srv = await startRemoteMcp({
      oauth: true,
      // Stands in for the authorization server fetching the client_id URL.
      cimd: async (clientId) => {
        const u = new URL(clientId);
        if (u.origin !== "https://fastcar.test") return null;
        const res = await app.inject({ method: "GET", url: u.pathname });
        return res.statusCode === 200 ? res.json() : null;
      },
    });
  });

  after(async () => {
    for (const n of names) await manager.remove(n).catch(() => {});
    await manager.shutdown();
    await app.close();
    await srv.close();
    await closePool();
  });

  it("serves a metadata document whose client_id is its own URL", async () => {
    const res = await app.inject({ method: "GET", url: "/api/mcp/oauth/client-metadata.json" });
    assert.equal(res.statusCode, 200);
    const doc = res.json();
    assert.equal(doc.client_id, CLIENT_ID);
    assert.deepEqual(doc.redirect_uris, ["https://fastcar.test/api/mcp/oauth/callback"]);
    assert.equal(doc.token_endpoint_auth_method, "none");
  });

  it("signs in without dynamic registration", async () => {
    const name = uniq("cimd");
    names.push(name);
    const pending = await manager.install({ source: `${srv.url}/mcp`, name });
    assert.equal(pending.status, "needs_auth");
    const authUrl = new URL(pending.authorizationUrl!);
    assert.equal(authUrl.searchParams.get("client_id"), CLIENT_ID);
    assert.ok(!srv.requests.some((r) => r.path === "/register"), "never tried to register");

    const res = await fetch(authUrl, { redirect: "manual" });
    assert.equal(res.status, 302, "the authorization server accepted the metadata document");
    const callback = new URL(res.headers.get("location")!);
    const done = await manager.completeAuthorization(
      callback.searchParams.get("state")!,
      callback.searchParams.get("code")!,
    );
    assert.equal(done.status, "connected");
    assert.equal(await manager.callTool(name, "echo", { text: "c" }), "remote echo: c");
  });

  it("explains the https requirement instead of claiming there is no OAuth", async () => {
    const httpCfg = { ...loadConfig(), publicUrl: "http://localhost:3000" };
    const plain = new McpManager(httpCfg);
    await plain.start();
    try {
      await assert.rejects(
        () => plain.install({ source: `${srv.url}/mcp`, name: uniq("cimdhttp") }),
        (err: Error) => {
          assert.match(err.message, /Client ID Metadata Documents/);
          assert.match(err.message, /FASTCAR_PUBLIC_URL/);
          assert.doesNotMatch(err.message, /does not advertise OAuth/);
          return true;
        },
      );
    } finally {
      await plain.shutdown();
    }
    const httpApp = Fastify();
    registerRoutes(httpApp, httpCfg, { artifacts: new ArtifactService(httpCfg), email: new EmailService(httpCfg) });
    const res = await httpApp.inject({ method: "GET", url: "/api/mcp/oauth/client-metadata.json" });
    await httpApp.close();
    assert.equal(res.statusCode, 404, "no document on a non-https deployment");
  });
});
