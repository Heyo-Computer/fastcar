import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import { execFileSync } from "node:child_process";
import { loadConfig } from "../config.js";
import { migrate } from "../db/migrate.js";
import { closePool, getPool } from "../db/pool.js";
import { buildModels } from "../pi/runtime.js";
import { SubagentManager } from "../pi/subagents.js";
import { ThreadManager } from "../threads/manager.js";
import { EmailService } from "../services/emailService.js";
import { startMockOpenAI } from "../dev/mock-openai.js";
import { deleteThread, getThread } from "../db/threads.js";
import type { ServerMessage } from "@fastcar/shared";

// Integration test for prompt threads (Feature 3): create a prompt thread, the
// LLM runs (mock OpenAI), the result is POSTed to a mock https webhook with the
// bearer token, and the delivery status is recorded in the thread history.

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

interface MockWebhook {
  server: https.Server;
  url: string;
  receivedAuth: string[];
  receivedBody: string[];
}

function startMockHttpsWebhook(): Promise<MockWebhook> {
  const receivedAuth: string[] = [];
  const receivedBody: string[] = [];
  // Generate a self-signed cert so https.createServer has something to serve.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fastcar-wh-"));
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
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c as Buffer));
      req.on("end", () => {
        receivedBody.push(Buffer.concat(chunks).toString("utf8"));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    },
  );
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        server,
        url: `https://127.0.0.1:${port}/hook`,
        receivedAuth,
        receivedBody,
      });
    });
  });
}

describe("prompt threads (Feature 3)", () => {
  let cfg: ReturnType<typeof loadConfig>;
  let mockOpenAI: http.Server | undefined;
  let webhook: MockWebhook;
  let manager: ThreadManager;

  before(async () => {
    process.env.FASTCAR_MOCK = "1";
    process.env.DATABASE_URL = DATABASE_URL;
    // Allow the self-signed loopback webhook cert for the delivery fetch.
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
  });

  after(async () => {
    mockOpenAI?.close();
    webhook.server.close();
    await manager.shutdown().catch(() => {});
    await closePool();
  });

  it("runs the LLM and POSTs the result to the webhook with the bearer token", async () => {
    const thread = await manager.createPromptThread({
      templateId: "default",
      variables: { prompt: "Say hello." },
      webhookUrl: webhook.url,
      webhookToken: "bearer-secret-token",
    });

    const result = await waitFor(
      manager,
      "prompt_thread_result",
      (m) => m.threadId === thread.id,
      15_000,
    );
    assert.equal(result.status, "success", `expected success, got: ${result.response}`);

    // The webhook received exactly one POST with the bearer token.
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(webhook.receivedAuth.length, 1, "webhook received one request");
    assert.equal(webhook.receivedAuth[0], "Bearer bearer-secret-token");
    const body = JSON.parse(webhook.receivedBody[0]!);
    assert.equal(body.threadId, thread.id);
    assert.ok(body.response, "response included in webhook payload");

    // The thread is a prompt thread with the delivery status recorded.
    const rec = await getThread(thread.id);
    assert.equal(rec?.threadType, "prompt");
    assert.equal(rec?.promptConfig?.webhookStatus, "success");
    await deleteThread(thread.id);
  });

  it("rejects a non-https webhook URL at creation", async () => {
    await assert.rejects(
      manager.createPromptThread({
        templateId: "default",
        variables: { prompt: "x" },
        webhookUrl: "http://example.com/hook",
        webhookToken: "tok",
      }),
      /HTTPS/,
    );
  });

  it("rejects an unknown template id", async () => {
    await assert.rejects(
      manager.createPromptThread({
        templateId: "no-such-template",
        webhookUrl: webhook.url,
        webhookToken: "tok",
      }),
      /no such prompt template/,
    );
  });
});
