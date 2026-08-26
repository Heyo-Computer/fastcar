import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import type http from "node:http";
import type { Config } from "../config.js";
import { registerRoutes } from "../http/routes.js";
import { buildModels, resolveSubagentModel } from "../pi/runtime.js";
import { SubagentManager, type SubagentKind } from "../pi/subagents.js";
import { startMockOpenAI, type MockChatRequestRecord } from "../dev/mock-openai.js";
import {
  SubagentSettings,
  subagentSettingsEvents,
} from "../services/subagentSettings.js";
import { ArtifactService } from "../services/artifacts.js";
import { EmailService } from "../services/emailService.js";

// Exercises the configurable subagent-models feature end to end without the
// network:
//   - SubagentSettings store: defaults from env, persistence, validation, the
//     "changed" event;
//   - REST surface: GET /api/subagent-models returns the store; POST persists
//     (and is admin-gated when an admin token is set).

function tempConfig(dataDir: string, overrides: Partial<Config> = {}): Config {
  return {
    port: 3000,
    databaseUrl: "",
    mock: true,
    mockPort: 3210,
    workdir: dataDir,
    dataDir,
    sessionDir: path.join(dataDir, "sessions"),
    reposDir: path.join(dataDir, "repos"),
    mcpDir: path.join(dataDir, "mcp"),
    gitName: undefined,
    gitEmail: undefined,
    maxcodingModel: "anthropic/claude-sonnet-4.5",
    minimodelModel: "google/gemini-2.5-flash-lite",
    transcribeModel: "openai/whisper-large-v3",
    tavilyApiKey: undefined,
    openrouterBaseUrl: "",
    subagentProvider: "openrouter",
    omlxBaseUrl: "http://localhost:8080/v1",
    inceptionBaseUrl: "",
    inceptionModel: "mercury-2.5",
    inceptionMaxTokens: 16384,
    conductorReasoningEffort: "medium",
    adminToken: undefined,
    defaultOwner: null,
    publicUrl: "http://public.test",
    ...overrides,
  };
}

async function makeApp(cfg: Config, subagentSettings: SubagentSettings) {
  const app = Fastify();
  registerRoutes(app, cfg, {
    artifacts: new ArtifactService(cfg),
    email: new EmailService(cfg),
    subagentSettings,
  });
  await app.ready();
  return app;
}

describe("SubagentSettings store", () => {
  let tmp: string;
  let cfg: Config;

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fastcar-subagent-"));
    cfg = tempConfig(tmp);
  });
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("falls back to env defaults and reports them", () => {
    const s = new SubagentSettings(cfg);
    const got = s.get();
    assert.equal(got.provider, "openrouter");
    assert.equal(got.omlxBaseUrl, "http://localhost:8080/v1");
    assert.equal(got.maxcoding.model, null);
    assert.equal(got.minimodel.model, null);
    assert.equal(got.defaults.provider, "openrouter");
    assert.equal(got.defaults.maxcodingModel, "anthropic/claude-sonnet-4.5");
    assert.equal(got.defaults.minimodelModel, "google/gemini-2.5-flash-lite");
    assert.equal(got.defaults.omlxBaseUrl, "http://localhost:8080/v1");
  });

  it("persists partial updates and emits 'changed'", () => {
    const s = new SubagentSettings(cfg);
    let changes = 0;
    const onChanged = () => changes++;
    subagentSettingsEvents.on("changed", onChanged);
    try {
      const res = s.update({ provider: "omlx", omlxBaseUrl: "http://omlx.local/v1" });
      assert.equal(res.provider, "omlx");
      assert.equal(res.omlxBaseUrl, "http://omlx.local/v1");
      assert.equal(changes, 1);
      // A fresh instance reads the same file.
      const fresh = new SubagentSettings(cfg);
      assert.equal(fresh.provider(), "omlx");
      assert.equal(fresh.omlxBaseUrl(), "http://omlx.local/v1");
      // Omitted fields keep their value.
      assert.equal(s.update({}).provider, "omlx");
      assert.equal(changes, 2);
    } finally {
      subagentSettingsEvents.off("changed", onChanged);
    }
  });

  it("accepts per-kind model overrides and a null reset", () => {
    const s = new SubagentSettings(cfg);
    const res = s.update({ maxcoding: { model: "qwen/qwen3-coder" } });
    assert.equal(res.maxcoding.model, "qwen/qwen3-coder");
    assert.equal(s.maxcodingModel(), "qwen/qwen3-coder");
    // minimodel untouched.
    assert.equal(s.minimodelModel(), null);
    const reset = s.update({ maxcoding: { model: null } });
    assert.equal(reset.maxcoding.model, null);
    assert.equal(s.maxcodingModel(), null);
  });

  it("rejects bad values without writing", () => {
    const s = new SubagentSettings(cfg);
    const before = s.get();
    assert.throws(() => s.update({ provider: "bedrock" as never }), /provider must be one of/);
    assert.throws(() => s.update({ omlxBaseUrl: "  " }), /omlxBaseUrl must be a non-empty string/);
    assert.throws(() => s.update({ maxcoding: { model: "" } }), /maxcoding.model must be/);
    // Nothing persisted.
    assert.deepEqual(s.get(), before);
  });
});

describe("subagent-models REST endpoints", () => {
  let tmp: string;
  let cfg: Config;

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fastcar-subagent-rest-"));
    cfg = tempConfig(tmp);
  });
  after(async () => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("GET /api/subagent-models returns the store", async () => {
    const settings = new SubagentSettings(cfg);
    const app = await makeApp(cfg, settings);
    try {
      const res = await app.inject({ method: "GET", url: "/api/subagent-models" });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.provider, "openrouter");
      assert.equal(body.omlxBaseUrl, "http://localhost:8080/v1");
      assert.equal(body.maxcoding.model, null);
    } finally {
      await app.close();
    }
  });

  it("POST /api/subagent-models persists and returns the new settings", async () => {
    const settings = new SubagentSettings(cfg);
    const app = await makeApp(cfg, settings);
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/subagent-models",
        payload: { provider: "omlx", maxcoding: { model: "qwen/qwen3-coder" } },
      });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.provider, "omlx");
      assert.equal(body.maxcoding.model, "qwen/qwen3-coder");
      // Persisted to a fresh store.
      assert.equal(new SubagentSettings(cfg).provider(), "omlx");
    } finally {
      await app.close();
    }
  });

  it("POST rejects invalid bodies with 400", async () => {
    const settings = new SubagentSettings(cfg);
    const app = await makeApp(cfg, settings);
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/subagent-models",
        payload: { provider: "bedrock" },
      });
      assert.equal(res.statusCode, 400);
      assert.match(res.json().error, /provider must be one of/);
    } finally {
      await app.close();
    }
  });

  it("POST is admin-gated when an admin token is configured", async () => {
    const adminCfg = tempConfig(tmp, { adminToken: "secret" });
    const settings = new SubagentSettings(adminCfg);
    const app = await makeApp(adminCfg, settings);
    try {
      const unauthorized = await app.inject({
        method: "POST",
        url: "/api/subagent-models",
        payload: { provider: "omlx" },
      });
      assert.equal(unauthorized.statusCode, 403);

      const authorized = await app.inject({
        method: "POST",
        url: "/api/subagent-models",
        headers: { authorization: "Bearer secret" },
        payload: { provider: "omlx" },
      });
      assert.equal(authorized.statusCode, 200);
      assert.equal(authorized.json().provider, "omlx");
    } finally {
      await app.close();
    }
  });

  it("404s when no subagent settings service is wired in", async () => {
    const app = Fastify();
    registerRoutes(app, cfg, {
      artifacts: new ArtifactService(cfg),
      email: new EmailService(cfg),
    });
    await app.ready();
    try {
      const get = await app.inject({ method: "GET", url: "/api/subagent-models" });
      assert.equal(get.statusCode, 404);
      const post = await app.inject({ method: "POST", url: "/api/subagent-models", payload: {} });
      assert.equal(post.statusCode, 404);
    } finally {
      await app.close();
    }
  });
});

// Exercises the OMLX provider registration and the subagent model resolution
// against the mock OpenAI server on its own port, so it can sit next to a dev
// server. Confirms that wiring SubagentSettings into SubagentManager routes a
// run through the configured provider.

describe("subagent model resolution + OMLX provider", () => {
  const MOCK_PORT = Number(process.env.FASTCAR_TEST_MOCK_PORT ?? 3218);
  let tmp: string;
  let cfg: Config;
  let mock: http.Server;

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fastcar-subagent-rt-"));
    cfg = tempConfig(tmp, {
      mock: true,
      mockPort: MOCK_PORT,
      openrouterBaseUrl: `http://127.0.0.1:${MOCK_PORT}/api/v1`,
      inceptionBaseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`,
    });
    process.env.INCEPTION_API_KEY ??= "mock-key";
    process.env.OPENROUTER_API_KEY ??= "mock-key";
    process.env.OMLX_API_KEY ??= "mock-key";
    mock = await startMockOpenAI(MOCK_PORT);
  });

  after(async () => {
    await new Promise<void>((resolve) => mock.close(() => resolve()));
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  async function recordedRequests(): Promise<MockChatRequestRecord[]> {
    const res = await fetch(`http://127.0.0.1:${MOCK_PORT}/__mock/requests`);
    return ((await res.json()) as { requests: MockChatRequestRecord[] }).requests;
  }

  it("registers the OMLX provider at boot", async () => {
    const { runtime } = await buildModels(cfg);
    const provider = runtime.getProvider("omlx-mock");
    assert.ok(provider, "omlx provider registered");
    // Mock mode points OMLX at the mock server.
    assert.equal(provider?.baseUrl, `http://127.0.0.1:${MOCK_PORT}/v1`);
  });

  it("resolveSubagentModel uses OMLX when the settings say so", async () => {
    const { runtime } = await buildModels(cfg);
    const model = resolveSubagentModel(runtime, cfg, "maxcoding", {
      provider: "omlx",
      omlxBaseUrl: "http://localhost:8080/v1",
      model: "qwen/qwen3-coder",
    });
    assert.equal(model.provider, "omlx-mock");
    assert.equal(model.id, "qwen/qwen3-coder");
  });

  it("resolveSubagentModel keeps OpenRouter and the env default slug", async () => {
    const { runtime } = await buildModels(cfg);
    const model = resolveSubagentModel(runtime, cfg, "minimodel", {
      provider: "openrouter",
      omlxBaseUrl: cfg.omlxBaseUrl,
      model: null,
    });
    assert.equal(model.id, cfg.minimodelModel);
  });

  it("a SubagentManager run with OMLX settings hits the OMLX provider", async () => {
    const models = await buildModels(cfg);
    const settings = new SubagentSettings(cfg);
    settings.update({ provider: "omlx", maxcoding: { model: "qwen/qwen3-coder" } });
    const manager = new SubagentManager(models, cfg, undefined, settings);

    const before = (await recordedRequests()).length;
    await manager.run({
      kind: "maxcoding" as SubagentKind,
      task: "Summarize the directory.",
      taskId: "test-omlx-run",
      signal: undefined,
      onEvent: () => {},
    });

    const requests = (await recordedRequests()).slice(before);
    assert.ok(requests.length > 0, "the run produced at least one chat request");
    // Every request the OMLX-configured run made used the OMLX model slug.
    for (const r of requests) {
      assert.equal(r.model, "qwen/qwen3-coder");
    }
  });
});