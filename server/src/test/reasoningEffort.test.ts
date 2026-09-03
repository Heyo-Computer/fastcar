import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type http from "node:http";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { Config } from "../config.js";
import { buildModels, conductorEffortToThinkingLevel } from "../pi/runtime.js";
import { AppSettings, appSettingsEvents } from "../services/appSettings.js";
import { startMockOpenAI, type MockChatRequestRecord } from "../dev/mock-openai.js";

// Conductor reasoning effort: the ⚙ setting → Pi thinking level → Mercury's
// `reasoning_effort` on the wire, plus the settings store itself. Runs against
// the mock OpenAI server on its own port so it can sit next to a dev server.

const MOCK_PORT = Number(process.env.FASTCAR_TEST_MOCK_PORT ?? 3217);

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
    conductorReasoningEffort: "medium",
    adminToken: undefined,
    defaultOwner: null,
    publicUrl: "http://public.test",
  };
}

async function recordedRequests(): Promise<MockChatRequestRecord[]> {
  const res = await fetch(`http://127.0.0.1:${MOCK_PORT}/__mock/requests`);
  return ((await res.json()) as { requests: MockChatRequestRecord[] }).requests;
}

describe("conductor reasoning effort", () => {
  let tmp: string;
  let cfg: Config;
  let mock: http.Server;

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fastcar-effort-"));
    cfg = tempConfig(tmp);
    process.env.INCEPTION_API_KEY ??= "mock-key";
    process.env.OPENROUTER_API_KEY ??= "mock-key";
    mock = await startMockOpenAI(MOCK_PORT);
  });

  after(async () => {
    await new Promise<void>((resolve) => mock.close(() => resolve()));
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("maps the UI effort onto Pi thinking levels the model accepts", () => {
    assert.equal(conductorEffortToThinkingLevel("instant"), "low");
    assert.equal(conductorEffortToThinkingLevel("medium"), "medium");
    assert.equal(conductorEffortToThinkingLevel("high"), "high");
  });

  it("registers the configured Mercury model as reasoning-capable", async () => {
    const { conductor } = await buildModels(cfg);
    assert.equal(conductor.provider, "inceptionlabs");
    assert.equal(conductor.id, "mercury-2.5");
    assert.equal(conductor.reasoning, true);
    assert.equal(conductor.maxTokens, 12345);
    assert.equal(
      (conductor.compat as { supportsReasoningEffort?: boolean } | undefined)?.supportsReasoningEffort,
      true,
    );
  });

  it("sends Mercury's reasoning_effort and max_tokens on the wire", async () => {
    const { conductor } = await buildModels(cfg);
    const context = { messages: [{ role: "user" as const, content: "hi", timestamp: Date.now() }] };
    for (const [level, expected] of [
      ["low", "instant"],
      ["medium", "medium"],
      ["high", "high"],
    ] as const) {
      const before = (await recordedRequests()).length;
      const msg = await completeSimple(conductor, context, { reasoning: level, apiKey: "mock-key" });
      assert.equal(msg.stopReason, "stop", `level ${level}: ${msg.errorMessage ?? ""}`);
      const requests = await recordedRequests();
      const last = requests[requests.length - 1];
      assert.equal(requests.length, before + 1);
      assert.ok(last, "mock recorded the request");
      assert.equal(last.model, "mercury-2.5");
      assert.equal(last.reasoning_effort, expected, `thinking level ${level}`);
      assert.equal(last.max_tokens, 12345);
    }
  });

  it("AppSettings falls back to the env default and persists updates", () => {
    const settings = new AppSettings(cfg);
    assert.equal(settings.conductorReasoningEffort(), "medium");
    assert.equal(settings.get().conductor.model, "inceptionlabs/mercury-2.5");
    assert.equal(settings.get().conductor.maxTokens, 12345);

    let changes = 0;
    const onChanged = () => changes++;
    appSettingsEvents.on("changed", onChanged);
    try {
      const res = settings.update({ conductor: { reasoningEffort: "high" } });
      assert.equal(res.conductor.reasoningEffort, "high");
      assert.equal(res.conductor.defaultReasoningEffort, "medium");
      assert.equal(changes, 1);
      // A fresh instance reads the same file.
      assert.equal(new AppSettings(cfg).conductorReasoningEffort(), "high");
      // Omitted fields keep their value; bad values are rejected without writing.
      assert.equal(settings.update({}).conductor.reasoningEffort, "high");
      assert.throws(
        () => settings.update({ conductor: { reasoningEffort: "turbo" as never } }),
        /reasoningEffort must be one of/,
      );
      assert.equal(settings.conductorReasoningEffort(), "high");
      assert.equal(changes, 2);
    } finally {
      appSettingsEvents.off("changed", onChanged);
    }
  });
});
