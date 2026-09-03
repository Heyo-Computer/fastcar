import path from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import type { ReasoningEffort, ThreadMode } from "@fastcar/shared";
import type { Config } from "../config.js";
import { recentMemories } from "../db/memories.js";
import { createAskUserTool, type AskUserBridge } from "../tools/askUser.js";
import { createEmailTool } from "../tools/email.js";
import { createMemoryTools } from "../tools/memory.js";
import {
  createRunSubagentTool,
  isReadOnlySubagentCall,
  type SubagentEventSink,
} from "../tools/runSubagent.js";
import { createSubmitPlanTool, type SubmitPlanBridge } from "../tools/submitPlan.js";
import { createWebSearchTool } from "../tools/webSearch.js";
import { createBrowserCheckTool } from "../tools/browserCheck.js";
import { createGitTools, GIT_MUTATING_TOOLS, GIT_TOOL_NAMES } from "../tools/git.js";
import {
  createHeyctlTools,
  HEYCTL_MUTATING_TOOLS,
  HEYCTL_TOOL_NAMES,
} from "../tools/heyctl.js";
import { ARTIFACT_MUTATING_TOOLS, ARTIFACT_TOOL_NAMES, createArtifactTools } from "../tools/artifacts.js";
import { createMcpTools, MCP_MUTATING_TOOLS, MCP_TOOL_NAMES } from "../tools/mcp.js";
import type { McpManager } from "../services/mcp.js";
import type { ArtifactService } from "../services/artifacts.js";
import type { EmailService } from "../services/emailService.js";
import { conductorPrompt } from "./prompts.js";
import { conductorEffortToThinkingLevel, type FastcarModels } from "./runtime.js";
import type { SubagentManager } from "./subagents.js";

/**
 * Tools that mutate state and are blocked while a thread is in plan mode.
 * run_subagent is gated separately: read-only runs (minimodel, or maxcoding
 * with mode=plan) are allowed so exploration and plan-writing can fan out.
 */
const MUTATING_TOOLS = new Set([
  "bash",
  "edit",
  "write",
  "memory_delete",
  ...GIT_MUTATING_TOOLS,
  ...HEYCTL_MUTATING_TOOLS,
  ...ARTIFACT_MUTATING_TOOLS,
  ...MCP_MUTATING_TOOLS,
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
  /** Email service for the `email` agent tool (Feature 2). Optional in dev/smoke. */
  email?: EmailService;
  /** Artifact store for the create/update/list_artifacts tools. Optional in dev/smoke. */
  artifacts?: ArtifactService;
  /** MCP server registry for the mcp_* tools. Optional in dev/smoke. */
  mcp?: McpManager;
  /** Existing Pi JSONL session file to resume, or null for a fresh session. */
  sessionFile: string | null;
  /** Mercury reasoning_effort for this session's turns (settings UI / env default). */
  reasoningEffort: ReasoningEffort;
}

export interface ConductorHandle {
  session: AgentSession;
  /** Re-read memories and rebuild the system prompt (call after a mode flip). */
  refreshSystemPrompt: () => Promise<void>;
  /** Change the reasoning effort; takes effect from the next model turn (mid-run too). */
  setReasoningEffort: (effort: ReasoningEffort) => void;
}

export async function createConductorSession(deps: ConductorDeps): Promise<ConductorHandle> {
  const { cfg, models, threadId } = deps;
  const agentDir = path.join(cfg.dataDir, "agent");

  let memories = await recentMemories();
  let mcpSummary = (await deps.mcp?.promptSummary()) ?? "";
  const loader = new DefaultResourceLoader({
    cwd: cfg.workdir,
    agentDir,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => conductorPrompt(deps.getMode(), memories, mcpSummary),
  });
  await loader.reload();

  const sessionManager = deps.sessionFile
    ? SessionManager.open(deps.sessionFile, cfg.sessionDir, cfg.workdir)
    : SessionManager.create(cfg.workdir, cfg.sessionDir);

  // Feature 2: the `email` agent tool is only registered when an EmailService
  // is wired in (the dev/smoke entry point runs without one).
  const emailTool = deps.email ? [createEmailTool(deps.email)] : [];
  const emailNames = deps.email ? ["email"] : [];
  const artifactTools = deps.artifacts ? createArtifactTools(deps.artifacts, threadId) : [];
  const artifactNames = deps.artifacts ? ARTIFACT_TOOL_NAMES : [];
  const mcpTools = deps.mcp ? createMcpTools(deps.mcp) : [];
  const mcpNames = deps.mcp ? MCP_TOOL_NAMES : [];

  const { session } = await createAgentSession({
    cwd: cfg.workdir,
    agentDir,
    modelRuntime: models.runtime,
    model: models.conductor,
    thinkingLevel: conductorEffortToThinkingLevel(deps.reasoningEffort),
    // The allowlist must name custom tools too — an allowlist of builtins alone
    // would disable every custom tool.
    tools: [
      "read", "bash", "edit", "write", "grep", "find", "ls",
      "run_subagent", "ask_user", "submit_plan",
      "memory_save", "memory_search", "memory_list", "memory_delete",
      "web_search", "browser_check", ...emailNames,
      ...GIT_TOOL_NAMES,
      ...HEYCTL_TOOL_NAMES,
      ...artifactNames,
      ...mcpNames,
    ],
    customTools: [
      createRunSubagentTool(deps.subagents, deps.onSubagentEvent),
      createAskUserTool(deps.askBridge),
      createSubmitPlanTool(deps.planBridge),
      ...createMemoryTools(threadId),
      createWebSearchTool(cfg),
      createBrowserCheckTool(cfg),
      ...emailTool,
      ...createGitTools(cfg),
      ...createHeyctlTools(),
      ...artifactTools,
      ...mcpTools,
    ],
    resourceLoader: loader,
    sessionManager,
    settingsManager: SettingsManager.inMemory(),
  });

  // A resumed JSONL session replays its own thinking level (possibly the old
  // "off"); the current setting always wins.
  const setReasoningEffort = (effort: ReasoningEffort): void => {
    session.setThinkingLevel(conductorEffortToThinkingLevel(effort));
  };
  setReasoningEffort(deps.reasoningEffort);

  // Plan-mode gate: one session per thread; the allowlist is fixed at creation,
  // so read-only enforcement happens per call here.
  session.agent.beforeToolCall = async ({ toolCall, args }) => {
    if (deps.getMode() !== "plan") return undefined;
    if (MUTATING_TOOLS.has(toolCall.name)) {
      return {
        block: true,
        reason: `Plan mode is active — ${toolCall.name} is read-only-blocked. Explore with read-only tools and call submit_plan when your plan is ready.`,
      };
    }
    if (toolCall.name === "mcp_call") {
      // MCP tools are opaque; only ones the server itself marks read-only may run here.
      const a = (args ?? {}) as { server?: string; tool?: string };
      const readOnly = a.server && a.tool ? await deps.mcp?.isReadOnlyTool(a.server, a.tool) : false;
      if (!readOnly) {
        return {
          block: true,
          reason: `Plan mode is active — mcp_call is blocked unless the server marks the tool read-only (${a.server ?? "?"}/${a.tool ?? "?"} is not). Use mcp_list_tools to inspect it and describe the call in your plan instead.`,
        };
      }
      return undefined;
    }
    if (toolCall.name === "run_subagent" && !isReadOnlySubagentCall(args)) {
      return {
        block: true,
        reason:
          'Plan mode is active — implementing subagents are blocked. Use agent="minimodel" for exploration or agent="maxcoding" with mode="plan" to have it write the plan (read-only), then call submit_plan when your plan is ready.',
      };
    }
    return undefined;
  };

  return {
    session,
    refreshSystemPrompt: async () => {
      memories = await recentMemories();
      mcpSummary = (await deps.mcp?.promptSummary()) ?? "";
      await loader.reload();
      // The session captures the system prompt at creation; push the rebuilt
      // prompt into live agent state so the next turn sees the current mode.
      session.agent.state.systemPrompt = conductorPrompt(deps.getMode(), memories, mcpSummary);
    },
    setReasoningEffort,
  };
}
