/**
 * A deployed-style MCP server for tests: one Node HTTP server exposing the same
 * `echo` tool over both remote transports a real deployment might speak.
 *
 *   POST/GET/DELETE /mcp          Streamable HTTP (spec 2025-03-26 onwards)
 *   GET /sse  +  POST /messages   legacy HTTP+SSE (spec 2024-11-05)
 *
 * Either can be put behind a bearer token, and /mcp can be made to demand
 * OAuth — which is the three shapes fastcar has to cope with when pointed at
 * a server someone else runs.
 */
import http from "node:http";
import { createHash, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";

export interface RemoteMcpOptions {
  /** Which transports to serve. Default: both. */
  transports?: Array<"streamable" | "sse">;
  /** Require `Authorization: Bearer <token>` on every MCP request. */
  bearer?: string;
  /**
   * Require OAuth: the MCP endpoints 401 with a resource_metadata pointer, and
   * this same server plays the authorization server — discovery, dynamic
   * client registration, an auto-approving /authorize, and a /token that
   * verifies the PKCE code_verifier. Enough of the MCP authorization spec to
   * exercise the SDK's whole client flow.
   */
  oauth?: boolean;
  /**
   * OAuth mode, Loops-style: no dynamic registration, only Client ID Metadata
   * Documents. `client_id` is a URL; this stands in for the authorization
   * server fetching it, and returns the document (or null when unreachable).
   */
  cimd?: (clientId: string) => Promise<{ client_id?: string; redirect_uris?: string[] } | null>;
}

export interface RemoteMcp {
  url: string;
  /** Requests seen, so tests can assert on headers and paths. */
  requests: Array<{ method: string; path: string; auth?: string }>;
  /** OAuth mode: revoke every issued token, as a provider would on sign-out. */
  revokeAll(): void;
  close(): Promise<void>;
}

function buildServer(): McpServer {
  const server = new McpServer({ name: "remote-echo", version: "1.0.0" });
  server.tool(
    "echo",
    "Echo the given text back",
    { text: z.string() },
    { readOnlyHint: true },
    async ({ text }) => ({ content: [{ type: "text", text: `remote echo: ${text}` }] }),
  );
  return server;
}

export async function startRemoteMcp(opts: RemoteMcpOptions = {}): Promise<RemoteMcp> {
  const transports = new Set(opts.transports ?? ["streamable", "sse"]);
  const requests: RemoteMcp["requests"] = [];
  // Streamable HTTP is stateful per session; SSE is one transport per stream.
  const streamable = new Map<string, StreamableHTTPServerTransport>();
  const sse = new Map<string, SSEServerTransport>();

  // OAuth mode state.
  const clients = new Map<string, { redirectUris: string[] }>();
  const codes = new Map<string, { challenge: string; redirectUri: string; clientId: string }>();
  const accessTokens = new Set<string>();
  const refreshTokens = new Set<string>();
  let base = "";

  const readRaw = (req: http.IncomingMessage): Promise<string> =>
    new Promise((resolve) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => resolve(raw));
    });

  const json = (res: http.ServerResponse, status: number, body: unknown) =>
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));

  const issueTokens = () => {
    const access = randomUUID();
    const refresh = randomUUID();
    accessTokens.add(access);
    refreshTokens.add(refresh);
    return { access_token: access, token_type: "Bearer", expires_in: 3600, refresh_token: refresh };
  };

  /** Handles the authorization-server side. Returns true when it answered. */
  const handleOAuth = async (req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> => {
    const p = url.pathname;
    if (p === "/.well-known/oauth-protected-resource" || p === "/.well-known/oauth-protected-resource/mcp") {
      json(res, 200, { resource: `${base}/mcp`, authorization_servers: [base] });
      return true;
    }
    if (p === "/.well-known/oauth-authorization-server") {
      json(res, 200, {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        ...(opts.cimd
          ? { client_id_metadata_document_supported: true }
          : { registration_endpoint: `${base}/register` }),
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
      return true;
    }
    if (p === "/register" && req.method === "POST" && !opts.cimd) {
      const body = JSON.parse((await readRaw(req)) || "{}") as { redirect_uris?: string[] };
      const clientId = `client-${randomUUID()}`;
      clients.set(clientId, { redirectUris: body.redirect_uris ?? [] });
      json(res, 201, { ...body, client_id: clientId, token_endpoint_auth_method: "none" });
      return true;
    }
    if (p === "/authorize" && req.method === "GET") {
      // Auto-approve: stands in for the user clicking "Allow".
      const q = url.searchParams;
      const clientId = q.get("client_id") ?? "";
      const redirectUri = q.get("redirect_uri") ?? "";
      if (opts.cimd && !clients.has(clientId)) {
        // CIMD: the document must name itself as the client_id it was fetched from.
        const doc = await opts.cimd(clientId).catch(() => null);
        if (doc?.client_id === clientId) clients.set(clientId, { redirectUris: doc.redirect_uris ?? [] });
      }
      if (!clients.get(clientId)?.redirectUris.includes(redirectUri)) {
        json(res, 400, { error: "invalid_request", error_description: "unknown client or redirect_uri" });
        return true;
      }
      if (q.get("code_challenge_method") !== "S256" || !q.get("code_challenge")) {
        json(res, 400, { error: "invalid_request", error_description: "PKCE S256 required" });
        return true;
      }
      const code = randomUUID();
      codes.set(code, { challenge: q.get("code_challenge")!, redirectUri, clientId });
      const back = new URL(redirectUri);
      back.searchParams.set("code", code);
      back.searchParams.set("state", q.get("state") ?? "");
      res.writeHead(302, { location: back.toString() }).end();
      return true;
    }
    if (p === "/token" && req.method === "POST") {
      const form = new URLSearchParams(await readRaw(req));
      if (form.get("grant_type") === "refresh_token") {
        const rt = form.get("refresh_token") ?? "";
        if (!refreshTokens.delete(rt)) return (json(res, 400, { error: "invalid_grant" }), true);
        json(res, 200, issueTokens());
        return true;
      }
      const entry = codes.get(form.get("code") ?? "");
      codes.delete(form.get("code") ?? "");
      const verifier = form.get("code_verifier") ?? "";
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      if (!entry || entry.challenge !== challenge || entry.redirectUri !== form.get("redirect_uri")) {
        json(res, 400, { error: "invalid_grant", error_description: "bad code, verifier or redirect_uri" });
        return true;
      }
      json(res, 200, issueTokens());
      return true;
    }
    return false;
  };

  const readBody = (req: http.IncomingMessage): Promise<unknown> =>
    new Promise((resolve) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        try {
          resolve(raw ? JSON.parse(raw) : undefined);
        } catch {
          resolve(undefined);
        }
      });
    });

  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    requests.push({ method: req.method ?? "", path: url.pathname, auth: req.headers.authorization });

    if (opts.oauth) {
      if (await handleOAuth(req, res, url)) return;
      const token = req.headers.authorization?.replace(/^Bearer /, "") ?? "";
      if (!accessTokens.has(token)) {
        // The MCP authorization spec's pointer to where discovery starts.
        res
          .writeHead(401, {
            "content-type": "application/json",
            "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
          })
          .end('{"error":"invalid_token"}');
        return;
      }
    } else if (opts.bearer && req.headers.authorization !== `Bearer ${opts.bearer}`) {
      res.writeHead(401, { "content-type": "application/json" }).end('{"error":"unauthorized"}');
      return;
    }

    // ---- Streamable HTTP ------------------------------------------------
    if (url.pathname === "/mcp") {
      if (!transports.has("streamable")) {
        // What an SSE-only deployment returns to a Streamable HTTP POST. The
        // spec's backwards-compatibility rule keys the fallback off a 4xx here.
        res.writeHead(405).end();
        return;
      }
      const sid = req.headers["mcp-session-id"] as string | undefined;
      let t = sid ? streamable.get(sid) : undefined;
      if (!t) {
        t = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            streamable.set(id, t!);
          },
        });
        t.onclose = () => {
          if (t!.sessionId) streamable.delete(t!.sessionId);
        };
        await buildServer().connect(t);
      }
      const body = req.method === "POST" ? await readBody(req) : undefined;
      await t.handleRequest(req, res, body);
      return;
    }

    // ---- legacy HTTP+SSE ------------------------------------------------
    if (url.pathname === "/sse" && req.method === "GET") {
      if (!transports.has("sse")) {
        res.writeHead(404).end();
        return;
      }
      const t = new SSEServerTransport("/messages", res);
      sse.set(t.sessionId, t);
      t.onclose = () => sse.delete(t.sessionId);
      await buildServer().connect(t);
      return;
    }
    if (url.pathname === "/messages" && req.method === "POST") {
      const t = sse.get(url.searchParams.get("sessionId") ?? "");
      if (!t) {
        res.writeHead(404).end();
        return;
      }
      await t.handlePostMessage(req, res, await readBody(req));
      return;
    }

    res.writeHead(404).end();
  });

  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const { port } = httpServer.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;

  return {
    url: base,
    requests,
    revokeAll: () => {
      accessTokens.clear();
      refreshTokens.clear();
    },
    close: async () => {
      for (const t of streamable.values()) await t.close().catch(() => {});
      for (const t of sse.values()) await t.close().catch(() => {});
      httpServer.closeAllConnections();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}
