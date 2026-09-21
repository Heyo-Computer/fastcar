/**
 * Per-agent session construction, asserted against what Pi actually put on the
 * wire (the mock OpenAI server records model, reasoning_effort, max_tokens and
 * the tool names of every chat request).
 *
 * The three things an agent definition controls are exactly the three things
 * the recorder captures, which is why this is the test that matters for
 * Phase 3. It builds ResolvedAgents by hand rather than going through the
 * database, so it stays a unit test.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type http from "node:http";
import type { Config } from "../config.js";
import { buildModels, type FastcarModels } from "../pi/runtime.js";
import { createManagedSession } from "../pi/agentSession.js";
import { SubagentManager } from "../pi/subagents.js";
import type { ResolvedAgent } from "../services/agents.js";
import { CONDUCTOR_DEFAULT_TOOLS } from "../tools/registry.js";
import { startMockOpenAI, type MockChatRequestRecord } from "../dev/mock-openai.js";
import { composeAgentPrompt, conductorPrompt } from "../pi/prompts.js";
import type { Memory } from "../db/memories.js";

const MOCK_PORT = Number(process.env.FASTCAR_TEST_MOCK_PORT ?? 3218);

/**
 * Frozen: what the conductor sent before agents existed. Order is not asserted
 * (Pi may reorder), but membership is exact.
 */
const CONDUCTOR_TOOLS_GOLDEN = [
  "read", "bash", "edit", "write", "grep", "find", "ls",
  "run_subagent", "ask_user", "submit_plan",
  "memory_save", "memory_search", "memory_list", "memory_delete",
  "web_search", "browser_check",
  "git_clone", "git_pull", "git_checkout", "git_commit", "git_push",
  "git_status", "git_purge", "git_list_repos",
  "heyctl",
].sort();

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

function agent(over: Partial<ResolvedAgent> = {}): ResolvedAgent {
  return {
    id: "00000000-0000-0000-0000-0000000000aa",
    slug: "test-agent",
    name: "Test Agent",
    isBuiltin: false,
    supportsPlanMode: true,
    systemPrompt: "You are a focused test agent.",
    modelProvider: "inceptionlabs",
    modelSlug: "mercury-2.5",
    reasoningEffort: "medium",
    effortPinned: false,
    maxTokens: null,
    tools: ["read", "grep"],
    mcpServers: null,
    ...over,
  };
}

async function recorded(): Promise<MockChatRequestRecord[]> {
  const res = await fetch(`http://127.0.0.1:${MOCK_PORT}/__mock/requests`);
  return ((await res.json()) as { requests: MockChatRequestRecord[] }).requests;
}

describe("per-agent session construction", () => {
  let tmp: string;
  let cfg: Config;
  let models: FastcarModels;
  let subagents: SubagentManager;
  let mock: http.Server;

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fastcar-agentsession-"));
    cfg = tempConfig(tmp);
    process.env.FASTCAR_MOCK = "1";
    // tempConfig() bypasses loadConfig(), which is what normally injects these
    // in mock mode (config.ts:103-104). Note the falsy check rather than `??=`:
    // the repo's .env sets INCEPTION_API_KEY to the empty string, which is
    // defined but useless, and Pi rejects it with "No API key found".
    if (!process.env.INCEPTION_API_KEY) process.env.INCEPTION_API_KEY = "mock-key";
    if (!process.env.OPENROUTER_API_KEY) process.env.OPENROUTER_API_KEY = "mock-key";
    mock = await startMockOpenAI(MOCK_PORT);
    models = await buildModels(cfg);
    subagents = new SubagentManager(models, cfg);
  });

  after(async () => {
    mock.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  /** Run one turn for an agent and return the request Pi sent. */
  async function turn(a: ResolvedAgent, text = "hello"): Promise<MockChatRequestRecord> {
    const before = (await recorded()).length;
    const handle = await createManagedSession({
      cfg,
      models,
      subagents,
      agent: a,
      threadId: "00000000-0000-0000-0000-000000000000",
      getMode: () => "act",
      askBridge: { ask: async () => "yes" },
      planBridge: { submit: () => {} },
      onSubagentEvent: () => {},
      sessionFile: null,
      reasoningEffort: a.reasoningEffort,
    });
    try {
      await handle.session.prompt(text);
    } finally {
      handle.session.dispose();
    }
    const after = await recorded();
    assert.ok(after.length > before, "the mock recorded no request");
    return after[after.length - 1]!;
  }

  it("sends only the tools the agent was granted", async () => {
    const req = await turn(agent({ tools: ["read", "grep", "web_search"] }));
    assert.deepEqual([...req.toolNames].sort(), ["grep", "read", "web_search"]);
  });

  it("gives two agents in one process different tool sets", async () => {
    const a = await turn(agent({ slug: "a", tools: ["read"] }));
    const b = await turn(agent({ slug: "b", tools: ["read", "ls", "find"] }));
    assert.deepEqual([...a.toolNames].sort(), ["read"]);
    assert.deepEqual([...b.toolNames].sort(), ["find", "ls", "read"]);
  });

  it("honours a pinned reasoning effort over the global default", async () => {
    // cfg.conductorReasoningEffort is "medium"; the agent pins "high".
    const req = await turn(agent({ reasoningEffort: "high", effortPinned: true }));
    assert.equal(req.reasoning_effort, "high");
  });

  it("follows the global effort when the agent pins none", async () => {
    const req = await turn(agent({ reasoningEffort: "instant", effortPinned: false }));
    // conductorEffortToThinkingLevel maps instant -> low -> "instant".
    assert.equal(req.reasoning_effort, "instant");
  });

  it("drops a tool whose service is absent, guidance included", async () => {
    // No ArtifactService in this context, so create_artifact never reaches Pi.
    const req = await turn(agent({ tools: ["read", "create_artifact"] }));
    assert.deepEqual([...req.toolNames].sort(), ["read"]);
  });

  it("the builtin conductor's request is unchanged", async () => {
    const builtin = agent({
      slug: "conductor",
      isBuiltin: true,
      systemPrompt: null,
      tools: [...CONDUCTOR_DEFAULT_TOOLS],
    });
    const req = await turn(builtin);
    assert.equal(req.model, "mercury-2.5");
    assert.equal(req.reasoning_effort, "medium");
    assert.equal(req.max_tokens, cfg.inceptionMaxTokens);
    // The golden omits email/artifact/mcp tools: this context wires none of
    // those services, exactly as the dev/smoke entry point does not.
    assert.deepEqual([...req.toolNames].sort(), CONDUCTOR_TOOLS_GOLDEN);
  });
});

/**
 * Prompt composition is a pure function, and the mock recorder does not
 * capture the system prompt, so it is asserted directly rather than through
 * the wire.
 */
describe("agent prompt composition", () => {
  const memories: Memory[] = [];

  it("the builtin still gets CONDUCTOR_BASE, byte for byte", () => {
    const builtin = agent({ systemPrompt: null, tools: [...CONDUCTOR_DEFAULT_TOOLS] });
    assert.equal(
      composeAgentPrompt(builtin, "act", memories, ""),
      conductorPrompt("act", memories, ""),
    );
    assert.equal(
      composeAgentPrompt(builtin, "plan", memories, "- **srv** — 1 tool(s): x"),
      conductorPrompt("plan", memories, "- **srv** — 1 tool(s): x"),
    );
  });

  it("a user agent leads with its own role", () => {
    const p = composeAgentPrompt(
      agent({ systemPrompt: "You are a haiku poet and nothing else." }),
      "act", memories, "",
    );
    assert.ok(p.startsWith("You are a haiku poet and nothing else."));
    assert.ok(!p.includes("conductor agent that orchestrates work"));
  });

  it("includes capability guidance only for the tools it holds", () => {
    const withArtifacts = composeAgentPrompt(
      agent({ tools: ["read", "create_artifact"] }), "act", memories, "",
    );
    assert.ok(withArtifacts.includes("publishing pages and documents"));
    assert.ok(!withArtifacts.includes("heyctl is a kubectl-shaped CLI"));

    const plain = composeAgentPrompt(agent({ tools: ["read"] }), "act", memories, "");
    assert.ok(!plain.includes("publishing pages and documents"));
    assert.ok(!plain.includes("Your team — delegate by default"));

    const delegator = composeAgentPrompt(
      agent({ tools: ["read", "run_subagent"] }), "act", memories, "",
    );
    assert.ok(delegator.includes("Your team — delegate by default"));
  });

  it("appends the plan addendum only when the agent can submit a plan", () => {
    const canPlan = composeAgentPrompt(
      agent({ tools: ["read", "submit_plan"], supportsPlanMode: true }), "plan", memories, "",
    );
    assert.ok(canPlan.includes("PLANNING MODE"));

    // No submit_plan means a plan-mode turn could never terminate; telling it
    // to submit one would just strand the thread.
    const cannot = composeAgentPrompt(
      agent({ tools: ["read"], supportsPlanMode: true }), "plan", memories, "",
    );
    assert.ok(!cannot.includes("PLANNING MODE"));
  });
});
