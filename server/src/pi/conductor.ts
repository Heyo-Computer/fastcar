import path from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import type { ThreadMode } from "@fastcar/shared";
import type { Config } from "../config.js";
import { recentMemories } from "../db/memories.js";
import { createAskUserTool, type AskUserBridge } from "../tools/askUser.js";
import { createMemoryTools } from "../tools/memory.js";
import { createRunSubagentTool, type SubagentEventSink } from "../tools/runSubagent.js";
import { createSubmitPlanTool, type SubmitPlanBridge } from "../tools/submitPlan.js";
import { createWebSearchTool } from "../tools/webSearch.js";
import { createGitTools, GIT_MUTATING_TOOLS, GIT_TOOL_NAMES } from "../tools/git.js";
import { conductorPrompt } from "./prompts.js";
import type { FastcarModels } from "./runtime.js";
import type { SubagentManager } from "./subagents.js";

/** Tools that mutate state and are blocked while a thread is in plan mode. */
const MUTATING_TOOLS = new Set([
  "bash",
  "edit",
  "write",
  "run_subagent",
  "memory_delete",
  ...GIT_MUTATING_TOOLS,
]);

export interface ConductorDeps {
  cfg: Config;
  models: FastcarModels;
  subagents: SubagentManager;
  threadId: string;
  /** Live mode getter — the ThreadManager owns mode transitions. */
  getMode: () => ThreadMode;
  askBridge: AskUserBridge;
  planBridge: SubmitPlanBridge;
  onSubagentEvent: SubagentEventSink;
  /** Existing Pi JSONL session file to resume, or null for a fresh session. */
  sessionFile: string | null;
}

export interface ConductorHandle {
  session: AgentSession;
  /** Re-read memories and rebuild the system prompt (call after a mode flip). */
  refreshSystemPrompt: () => Promise<void>;
}

export async function createConductorSession(deps: ConductorDeps): Promise<ConductorHandle> {
  const { cfg, models, threadId } = deps;
  const agentDir = path.join(cfg.dataDir, "agent");

  let memories = await recentMemories();
  const loader = new DefaultResourceLoader({
    cwd: cfg.workdir,
    agentDir,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => conductorPrompt(deps.getMode(), memories),
  });
  await loader.reload();

  const sessionManager = deps.sessionFile
    ? SessionManager.open(deps.sessionFile, cfg.sessionDir, cfg.workdir)
    : SessionManager.create(cfg.workdir, cfg.sessionDir);

  const { session } = await createAgentSession({
    cwd: cfg.workdir,
    agentDir,
    modelRuntime: models.runtime,
    model: models.conductor,
    thinkingLevel: "off",
    // The allowlist must name custom tools too — an allowlist of builtins alone
    // would disable every custom tool.
    tools: [
      "read", "bash", "edit", "write", "grep", "find", "ls",
      "run_subagent", "ask_user", "submit_plan",
      "memory_save", "memory_search", "memory_list", "memory_delete",
      "web_search",
      ...GIT_TOOL_NAMES,
    ],
    customTools: [
      createRunSubagentTool(deps.subagents, deps.onSubagentEvent),
      createAskUserTool(deps.askBridge),
      createSubmitPlanTool(deps.planBridge),
      ...createMemoryTools(threadId),
      createWebSearchTool(cfg),
      ...createGitTools(cfg),
    ],
    resourceLoader: loader,
    sessionManager,
    settingsManager: SettingsManager.inMemory(),
  });

  // Plan-mode gate: one session per thread; the allowlist is fixed at creation,
  // so read-only enforcement happens per call here.
  session.agent.beforeToolCall = async ({ toolCall }) => {
    if (deps.getMode() === "plan" && MUTATING_TOOLS.has(toolCall.name)) {
      return {
        block: true,
        reason: `Plan mode is active — ${toolCall.name} is read-only-blocked. Explore with read-only tools and call submit_plan when your plan is ready.`,
      };
    }
    return undefined;
  };

  return {
    session,
    refreshSystemPrompt: async () => {
      memories = await recentMemories();
      await loader.reload();
      // The session captures the system prompt at creation; push the rebuilt
      // prompt into live agent state so the next turn sees the current mode.
      session.agent.state.systemPrompt = conductorPrompt(deps.getMode(), memories);
    },
  };
}
