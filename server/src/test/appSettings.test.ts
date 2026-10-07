import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type http from "node:http";
import type { Config } from "../config.js";
import { buildModels, conductorModel, registerInceptionProvider } from "../pi/runtime.js";
import { AppSettings, maskKey } from "../services/appSettings.js";
import { startMockOpenAI, type MockChatRequestRecord } from "../dev/mock-openai.js";

// ⚙ overrides for the conductor model/budget and the provider API keys: they
// persist (keys encrypted), apply onto cfg / process.env, clear back to the
// env values, and keys never leave the server unmasked.

const MOCK_PORT = Number(process.env.FASTCAR_TEST_MOCK_PORT ?? 3218);
const ENV_INCEPTION_KEY = "env-inception-key-0000-abcd";

function tempConfig(dataDir: string): Config {
  return {
    port: 3000,
    databaseUrl: "",
    mock: true,
    mockPort: MOCK_PORT,
    workdir: dataDir,
    dataDir,
    sessionDir: path.join(dataDir, "sessions"),
    reposDir: path.join(dataDir, "repos"),
    mcpDir: path.join(dataDir, "mcp"),
    gitName: undefined,
    gitEmail: undefined,
    maxcodingModel: "x",
    minimodelModel: "y",
    transcribeModel: "z",
    tavilyApiKey: undefined,
    openrouterBaseUrl: `http://127.0.0.1:${MOCK_PORT}/api/v1`,
    subagentProvider: "openrouter",
    omlxBaseUrl: "http://localhost:8080/v1",
    inceptionBaseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`,
    inceptionModel: "mercury-2.5",
    inceptionMaxTokens: 12345,
    conductorDefaults: { model: "mercury-2.5", maxTokens: 12345 },
    envApiKeys: { inception: ENV_INCEPTION_KEY, openrouter: undefined, omlx: undefined },
    conductorReasoningEffort: "medium",
    adminToken: undefined,
    defaultOwner: null,
    publicUrl: "http://public.test",
    publicUrlFromEnv: true,
  };
}

async function lastRequest(): Promise<MockChatRequestRecord | undefined> {
  const res = await fetch(`http://127.0.0.1:${MOCK_PORT}/__mock/requests`);
  const { requests } = (await res.json()) as { requests: MockChatRequestRecord[] };
  return requests[requests.length - 1];
}

describe("app settings overrides", () => {
  let tmp: string;
  let cfg: Config;
  let mock: http.Server;
  const savedEnv = { ...process.env };

  before(async () => {
    mock = await startMockOpenAI(MOCK_PORT);
  });

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fastcar-appsettings-"));
    cfg = tempConfig(tmp);
    process.env.INCEPTION_API_KEY = ENV_INCEPTION_KEY;
    delete process.env.OPENROUTER_API_KEY;
  });

  after(async () => {
    process.env = savedEnv;
    await new Promise<void>((resolve) => mock.close(() => resolve()));
  });

  it("masks keys from the environment", () => {
    const res = new AppSettings(cfg).get();
    assert.deepEqual(res.keys.inception, {
      envVar: "INCEPTION_API_KEY",
      source: "env",
      preview: "••••abcd",
    });
    assert.deepEqual(res.keys.openrouter, { envVar: "OPENROUTER_API_KEY", source: "unset", preview: null });
    assert.ok(!JSON.stringify(res).includes(ENV_INCEPTION_KEY));
    assert.equal(maskKey("short"), "••••");
  });

  it("stores key overrides encrypted, applies them, and clears back to env", () => {
    const settings = new AppSettings(cfg);
    const override = "sk-or-override-key-9999-wxyz";
    const res = settings.update({ keys: { inception: "settings-inception-key-zz-1234", openrouter: override } });

    assert.equal(res.keys.inception.source, "settings");
    assert.equal(res.keys.inception.preview, "••••1234");
    assert.equal(res.keys.openrouter.preview, "••••wxyz");
    assert.ok(!JSON.stringify(res).includes(override));
    assert.equal(process.env.INCEPTION_API_KEY, "settings-inception-key-zz-1234");
    assert.equal(process.env.OPENROUTER_API_KEY, override);

    const file = fs.readFileSync(path.join(tmp, "settings.json"), "utf8");
    assert.ok(!file.includes(override), "key is encrypted at rest");
    assert.equal(fs.statSync(path.join(tmp, "settings.json")).mode & 0o777, 0o600);

    // Omitted keys are kept; null and "" both clear.
    settings.update({ keys: { inception: null } });
    assert.equal(process.env.INCEPTION_API_KEY, ENV_INCEPTION_KEY);
    assert.equal(process.env.OPENROUTER_API_KEY, override);
    const cleared = settings.update({ keys: { openrouter: "" } });
    assert.equal(process.env.OPENROUTER_API_KEY, undefined);
    assert.equal(cleared.keys.inception.source, "env");
    assert.equal(cleared.keys.openrouter.source, "unset");

    assert.throws(() => settings.update({ keys: { bogus: "x" } as never }), /unknown key bogus/);
  });

  it("re-applies stored overrides at construction (boot)", () => {
    new AppSettings(cfg).update({
      conductor: { modelId: "mercury-coder", maxTokens: 4096 },
      keys: { openrouter: "sk-or-boot-time-key-0001" },
    });
    delete process.env.OPENROUTER_API_KEY;
    const fresh = tempConfig(tmp);
    new AppSettings(fresh);
    assert.equal(fresh.inceptionModel, "mercury-coder");
    assert.equal(fresh.inceptionMaxTokens, 4096);
    assert.equal(process.env.OPENROUTER_API_KEY, "sk-or-boot-time-key-0001");
  });

  it("overrides the conductor model and budget, and clears back to env", () => {
    const settings = new AppSettings(cfg);
    let res = settings.update({ conductor: { modelId: " mercury-coder ", maxTokens: 2048 } });
    assert.equal(cfg.inceptionModel, "mercury-coder");
    assert.equal(cfg.inceptionMaxTokens, 2048);
    assert.equal(res.conductor.model, "inceptionlabs/mercury-coder");
    assert.equal(res.conductor.defaultModelId, "mercury-2.5");
    assert.equal(res.conductor.defaultMaxTokens, 12345);

    assert.throws(() => settings.update({ conductor: { maxTokens: 0 } }), /maxTokens must be/);
    assert.throws(() => settings.update({ conductor: { maxTokens: 1.5 } }), /maxTokens must be/);
    assert.equal(cfg.inceptionMaxTokens, 2048);

    res = settings.update({ conductor: { modelId: null, maxTokens: null } });
    assert.equal(cfg.inceptionModel, "mercury-2.5");
    assert.equal(res.conductor.maxTokens, 12345);
  });

  it("re-registers the conductor and sends the overridden model and key on the wire", async () => {
    const models = await buildModels(cfg);
    const settings = new AppSettings(cfg);
    settings.update({
      conductor: { modelId: "mercury-coder", maxTokens: 777 },
      keys: { inception: "live-override-key-5555" },
    });
    // What ThreadManager.onSettingsChanged does.
    registerInceptionProvider(models.runtime, cfg);
    const conductor = conductorModel(models.runtime, cfg);
    // Sessions send the model's maxTokens as max_tokens (see agentSession.test).
    assert.equal(conductor.maxTokens, 777);
    // The env model stays registered for agents pinned to it.
    assert.ok(models.runtime.getModel("inceptionlabs", "mercury-2.5"));

    const context = { messages: [{ role: "user" as const, content: "hi", timestamp: Date.now() }] };
    const msg = await models.runtime.complete(conductor, context);
    assert.equal(msg.stopReason, "stop", msg.errorMessage ?? "");
    const req = await lastRequest();
    assert.equal(req?.model, "mercury-coder");
    assert.equal(req?.apiKey, "live-override-key-5555");
  });
});
