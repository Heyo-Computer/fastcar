import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import Fastify from "fastify";
import { loadConfig } from "../config.js";
import { migrate } from "../db/migrate.js";
import { closePool, getPool } from "../db/pool.js";
import { buildModels } from "../pi/runtime.js";
import { SubagentManager } from "../pi/subagents.js";
import { ThreadManager } from "../threads/manager.js";
import { EmailService } from "../services/emailService.js";
import { WebhookTokenStore } from "../services/webhookTokens.js";
import { registerPublicPromptTriggerRoutes } from "../http/publicPromptTrigger.js";
import { startMockOpenAI } from "../dev/mock-openai.js";
import { deleteThread } from "../db/threads.js";
import type { ServerMessage } from "@fastcar/shared";

// HTTP-level test for the public prompt trigger endpoint (POST /pt/:threadId):
// boots a Fastify app with only the public trigger route + a real ThreadManager,
// then drives the unauthenticated capability URL with the correct/wrong token.

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://fastcar:fastcar@127.0.0.1:5432/fastcar";

function waitFor<T extends ServerMessage["type"]>(
  mgr: ThreadManager,
  type: T,
  pred: (m: Extract<ServerMessage, { type: T }>) => boolean = () => true,
  timeoutMs = 15_000,
): Promise<Extract<ServerMessage, { type: T }>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeoutMs);
    const off = mgr.addClient((msg) => {
      if (msg.type === type && pred(msg as Extract<ServerMessage, { type: T }>)) {
        clearTimeout(timer);
        off();
        resolve(msg as Extract<ServerMessage, { type: T }>);
      }
    });
  });
}

function startMockHttpsWebhook() {
  const receivedAuth: string[] = [];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fastcar-pt-"));
  const certPath = path.join(tmp, "cert.pem");
  const keyPath = path.join(tmp, "key.pem");
  execFileSync(
    "openssl",
    ["req", "-x509", "-newkey", "rsa:2048", "-keyout", keyPath, "-out", certPath,
     "-days", "1", "-nodes", "-subj", "/CN=127.0.0.1"],
    { stdio: "ignore" },
  );
  const server = https.createServer(
    { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) },
    (req, res) => {
      receivedAuth.push(req.headers["authorization"] ?? "");
      req.on("data", () => {});
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    },
  );
  return new Promise<{ server: https.Server; url: string; receivedAuth: string[] }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, url: `https://127.0.0.1:${port}/hook`, receivedAuth });
    });
  });
}

describe("POST /pt/:threadId (public trigger route)", () => {
  let cfg: ReturnType<typeof loadConfig>;
  let mockOpenAI: http.Server | undefined;
  let manager: ThreadManager;
  let app: Fastify.FastifyInstance;
  let tokens: WebhookTokenStore;
  let webhook: { server: https.Server; url: string; receivedAuth: string[] };

  before(async () => {
    process.env.FASTCAR_MOCK = "1";
    process.env.DATABASE_URL = DATABASE_URL;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    cfg = loadConfig();
    mockOpenAI = cfg.mock ? await startMockOpenAI(cfg.mockPort) : undefined;
    await migrate();
    await getPool().query("DELETE FROM artifacts");
    await getPool().query("DELETE FROM threads WHERE thread_type = 'prompt'");
    webhook = await startMockHttpsWebhook();
    const models = await buildModels(cfg);
    const subagents = new SubagentManager(models, cfg);
    const email = new EmailService(cfg);
    manager = new ThreadManager(cfg, models, subagents, email);
    tokens = new WebhookTokenStore(cfg);
    app = Fastify();
    registerPublicPromptTriggerRoutes(app, manager);
    await app.ready();
  });

  after(async () => {
    mockOpenAI?.close();
    webhook.server.close();
    await manager.shutdown().catch(() => {});
    await app.close().catch(() => {});
    await closePool();
  });

  it("returns 202 with the correct bearer trigger token and re-runs delivery", async () => {
    const thread = await manager.createPromptThread({
      templateId: "default",
      variables: { prompt: "Say hi." },
      webhookUrl: webhook.url,
      webhookToken: "bearer-secret",
    });
    await waitFor(manager, "prompt_thread_result", (m) => m.threadId === thread.id, 15_000);
    const triggerToken = tokens.getTriggerToken(thread.id);
    assert.ok(triggerToken);

    const res = await app.inject({
      method: "POST",
      url: `/pt/${thread.id}`,
      headers: { authorization: `Bearer ${triggerToken}` },
    });
    assert.equal(res.statusCode, 202);
    assert.equal(JSON.parse(res.body).status, "accepted");

    await waitFor(manager, "prompt_thread_result", (m) => m.threadId === thread.id, 15_000);
    await manager.deleteThread(thread.id);
  });

  it("accepts the token via X-Trigger-Token header", async () => {
    const thread = await manager.createPromptThread({
      templateId: "default",
      variables: { prompt: "x" },
      webhookUrl: webhook.url,
      webhookToken: "tok",
    });
    await waitFor(manager, "prompt_thread_result", (m) => m.threadId === thread.id, 15_000);
    const triggerToken = tokens.getTriggerToken(thread.id);

    const res = await app.inject({
      method: "POST",
      url: `/pt/${thread.id}`,
      headers: { "x-trigger-token": triggerToken },
    });
    assert.equal(res.statusCode, 202);
    await manager.deleteThread(thread.id);
  });

  it("returns 401 for a wrong token", async () => {
    const thread = await manager.createPromptThread({
      templateId: "default",
      variables: { prompt: "x" },
      webhookUrl: webhook.url,
      webhookToken: "tok",
    });
    await waitFor(manager, "prompt_thread_result", (m) => m.threadId === thread.id, 15_000);

    const res = await app.inject({
      method: "POST",
      url: `/pt/${thread.id}`,
      headers: { authorization: "Bearer wrong" },
    });
    assert.equal(res.statusCode, 401);
    await manager.deleteThread(thread.id);
  });

  it("returns 404 for a missing thread", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/pt/00000000-0000-0000-0000-000000000000",
      headers: { authorization: "Bearer x" },
    });
    assert.equal(res.statusCode, 404);
  });
});
