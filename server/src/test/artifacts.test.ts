import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import fastifyMultipart from "@fastify/multipart";
import { registerRoutes } from "../http/routes.js";
import { callerFromRequest } from "../http/auth.js";
import { ArtifactService } from "../services/artifacts.js";
import { EmailService } from "../services/emailService.js";
import { migrate } from "../db/migrate.js";
import { closePool, getPool } from "../db/pool.js";
import { createThread, deleteThread } from "../db/threads.js";
import type { Config } from "../config.js";

// Integration test for the artifact REST API (Feature 1) and the caller auth
// helper (Feature 1/2). Requires a live Postgres at DATABASE_URL.

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://fastcar:fastcar@127.0.0.1:5432/fastcar";

function tempConfig(dataDir: string): Config {
  return {
    port: 3000,
    databaseUrl: DATABASE_URL,
    mock: true,
    mockPort: 3210,
    workdir: dataDir,
    dataDir,
    sessionDir: path.join(dataDir, "sessions"),
    reposDir: path.join(dataDir, "repos"),
    gitName: undefined,
    gitEmail: undefined,
    maxcodingModel: "x",
    minimodelModel: "y",
    transcribeModel: "z",
    tavilyApiKey: undefined,
    openrouterBaseUrl: "",
    inceptionBaseUrl: "",
    adminToken: undefined,
    defaultOwner: null,
  };
}

async function makeApp(cfg: Config, deps: { artifacts: ArtifactService; email: EmailService }) {
  const app = Fastify();
  await app.register(fastifyMultipart);
  registerRoutes(app, cfg, deps);
  await app.ready();
  return app;
}

describe("artifacts REST + auth", () => {
  let cfg: Config;
  let artifacts: ArtifactService;
  let email: EmailService;
  let app: Awaited<ReturnType<typeof makeApp>>;
  let threadId: string;
  let childId: string;
  let subId: string;
  let tmp: string;

  before(async () => {
    process.env.DATABASE_URL = DATABASE_URL;
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fastcar-art-"));
    cfg = tempConfig(tmp);
    artifacts = new ArtifactService(cfg);
    email = new EmailService(cfg);
    await migrate();
    // Clean any leftover artifacts/threads from prior runs.
    await getPool().query("DELETE FROM artifacts");
    await getPool().query("DELETE FROM threads WHERE thread_type = 'prompt'");
    app = await makeApp(cfg, { artifacts, email });
    const rec = await createThread("act", "chat", "owner-alice");
    threadId = rec.id;
  });

  after(async () => {
    try {
      if (threadId) await deleteThread(threadId);
    } catch {
      /* ignore */
    }
    await app.close();
    await closePool();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("creates a root markdown artifact via JSON", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/threads/${threadId}/artifacts`,
      headers: { "content-type": "application/json", "x-owner-id": "owner-alice" },
      payload: { name: "notes.md", content: "# Notes\nhello", contentType: "text/markdown" },
    });
    assert.equal(res.statusCode, 200, res.payload);
    const body = res.json() as { artifact: { id: string; parentArtifactId: string | null } };
    assert.equal(body.artifact.parentArtifactId, null);
    childId = body.artifact.id;
  });

  it("creates a nested artifact under a parent", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/threads/${threadId}/artifacts`,
      headers: { "content-type": "application/json", "x-owner-id": "owner-alice" },
      payload: {
        name: "sub.md",
        content: "child",
        contentType: "text/markdown",
        parentArtifactId: childId,
      },
    });
    assert.equal(res.statusCode, 200, res.payload);
    const body = res.json() as { artifact: { id: string; parentArtifactId: string } };
    assert.equal(body.artifact.parentArtifactId, childId);
    subId = body.artifact.id;
  });

  it("returns the artifact tree nested under the parent", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/threads/${threadId}/artifacts`,
    });
    assert.equal(res.statusCode, 200, res.payload);
    const body = res.json() as { artifacts: Array<{ name: string; children: Array<{ name: string }> }> };
    const root = body.artifacts.find((a) => a.name === "notes.md");
    assert.ok(root, "root artifact present");
    assert.equal(root!.children.length, 1);
    assert.equal(root!.children[0]!.name, "sub.md");
  });

  it("fetches a single artifact with inline text content", async () => {
    const res = await app.inject({ method: "GET", url: `/api/artifacts/${subId}` });
    assert.equal(res.statusCode, 200, res.payload);
    const body = res.json() as { content?: string; name: string };
    assert.equal(body.name, "sub.md");
    assert.equal(body.content, "child");
  });

  it("persists artifact bytes to data/artifacts/", () => {
    const dir = path.join(cfg.dataDir, "artifacts", threadId);
    assert.ok(fs.existsSync(dir), "artifact dir exists");
    const files = fs.readdirSync(dir);
    assert.ok(files.length >= 2, "at least two artifact files on disk");
  });

  it("forbids a non-owner non-agent caller from creating artifacts", async () => {
    // Build an app whose config has an admin token set, so owner enforcement
    // actually fires (in dev mode everyone is an admin/agent and the gate
    // is permissive by design).
    const secureTmp = fs.mkdtempSync(path.join(os.tmpdir(), "fastcar-art-secure-"));
    const secureCfg = { ...tempConfig(secureTmp), adminToken: "admin-secret" };
    const secureArtifacts = new ArtifactService(secureCfg);
    const secureApp = await makeApp(secureCfg, {
      artifacts: secureArtifacts,
      email: new EmailService(secureCfg),
    });
    try {
      const other = await createThread("act", "chat", "owner-bob");
      try {
        // alice is neither the owner nor an admin (no bearer token).
        const res = await secureApp.inject({
          method: "POST",
          url: `/api/threads/${other.id}/artifacts`,
          headers: { "content-type": "application/json", "x-owner-id": "owner-alice" },
          payload: { name: "x.md", content: "y" },
        });
        assert.equal(res.statusCode, 403, res.payload);
        // The owner themselves is allowed.
        const ok = await secureApp.inject({
          method: "POST",
          url: `/api/threads/${other.id}/artifacts`,
          headers: { "content-type": "application/json", "x-owner-id": "owner-bob" },
          payload: { name: "ok.md", content: "y" },
        });
        assert.equal(ok.statusCode, 200, ok.payload);
      } finally {
        await deleteThread(other.id);
      }
    } finally {
      await secureApp.close();
      fs.rmSync(secureTmp, { recursive: true, force: true });
    }
  });

  it("deletes an artifact (and cascades to children)", async () => {
    const res = await app.inject({ method: "DELETE", url: `/api/artifacts/${childId}` });
    assert.equal(res.statusCode, 200, res.payload);
    const after = await app.inject({ method: "GET", url: `/api/artifacts/${childId}` });
    assert.equal(after.statusCode, 404);
    // The child should be cascade-deleted too.
    const afterSub = await app.inject({ method: "GET", url: `/api/artifacts/${subId}` });
    assert.equal(afterSub.statusCode, 404);
  });
});

describe("callerFromRequest (auth)", () => {
  const cfgNoToken = tempConfig(fs.mkdtempSync(path.join(os.tmpdir(), "fastcar-auth-")));

  it("treats everyone as admin in single-user dev mode (no admin token)", () => {
    const req = { headers: {} } as never;
    const c = callerFromRequest(cfgNoToken, req);
    assert.equal(c.isAdmin, true);
  });

  it("resolves the owner from x-owner-id when present", () => {
    const req = { headers: { "x-owner-id": "alice" } } as never;
    const c = callerFromRequest(cfgNoToken, req);
    assert.equal(c.ownerId, "alice");
  });
});
