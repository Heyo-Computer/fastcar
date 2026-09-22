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
import type { AskUserBridge } from "../tools/askUser.js";
import { isReadOnlySubagentCall, type SubagentEventSink } from "../tools/runSubagent.js";
import type { SubmitPlanBridge } from "../tools/submitPlan.js";
import { buildToolset, CONDITIONAL_PLAN_TOOLS, isMutating } from "../tools/registry.js";
import type { McpManager } from "../services/mcp.js";
import type { ArtifactService } from "../services/artifacts.js";
import type { EmailService } from "../services/emailService.js";
import type { SignalService } from "../services/signal.js";
import { composeAgentPrompt } from "./prompts.js";
import {
  conductorEffortToThinkingLevel,
  resolveAgentModel,
  type FastcarModels,
} from "./runtime.js";
import type { ResolvedAgent } from "../services/agents.js";
import type { SubagentManager } from "./subagents.js";

export interface AgentSessionDeps {
  cfg: Config;
  models: FastcarModels;
  subagents: SubagentManager;
  threadId: string;
  /**
   * The agent that owns this thread, with code defaults already applied.
   * Its prompt, model, effort, tool allowlist and MCP subset drive the session.
   */
  agent: ResolvedAgent;
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
  /** signal-cli bridge for the signal_* tools. Absent unless SIGNAL_ACCOUNT is set. */
  signal?: SignalService;
  /** Existing Pi JSONL session file to resume, or null for a fresh session. */
  sessionFile: string | null;
  /** Effort for this session's turns, already resolved (agent pin > ⚙ > env). */
  reasoningEffort: ReasoningEffort;
}

export interface AgentSessionHandle {
  session: AgentSession;
  /** Slug of the owning agent — the value written to events.agent. */
  agentSlug: string;
  /** Re-read memories and rebuild the system prompt (call after a mode flip). */
  refreshSystemPrompt: () => Promise<void>;
  /** Change the reasoning effort; takes effect from the next model turn (mid-run too). */
  setReasoningEffort: (effort: ReasoningEffort) => void;
  /** The agent definition this session was built from, for staleness checks. */
  builtFrom: ResolvedAgent;
}

export async function createManagedSession(deps: AgentSessionDeps): Promise<AgentSessionHandle> {
  const { cfg, models, threadId, agent } = deps;
  const agentDir = path.join(cfg.dataDir, "agent");

  let memories = await recentMemories();
  let mcpSummary = (await deps.mcp?.promptSummary(agent.mcpServers ?? undefined)) ?? "";
  const loader = new DefaultResourceLoader({
    cwd: cfg.workdir,
    agentDir,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => composeAgentPrompt(agent, deps.getMode(), memories, mcpSummary),
  });
  await loader.reload();

  const sessionManager = deps.sessionFile
    ? SessionManager.open(deps.sessionFile, cfg.sessionDir, cfg.workdir)
    : SessionManager.create(cfg.workdir, cfg.sessionDir);

  // The allowlist and the instances come from one resolved set, so they cannot
  // drift — see tools/registry.ts. Tools whose dependency is absent (no
  // EmailService in the dev/smoke entry point, for instance) are dropped here,
  // which is what the conditional spreads used to do by hand.
  const toolset = buildToolset(agent.tools, {
    cfg,
    threadId,
    subagents: deps.subagents,
    onSubagentEvent: deps.onSubagentEvent,
    askBridge: deps.askBridge,
    planBridge: deps.planBridge,
    email: deps.email,
    artifacts: deps.artifacts,
    mcp: deps.mcp,
    allowedMcpServers: agent.mcpServers ?? undefined,
    signal: deps.signal,
  });

  const { session } = await createAgentSession({
    cwd: cfg.workdir,
    agentDir,
    modelRuntime: models.runtime,
    model: resolveAgentModel(models.runtime, cfg, agent),
    thinkingLevel: conductorEffortToThinkingLevel(deps.reasoningEffort),
    tools: toolset.tools,
    customTools: toolset.customTools,
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
    if (deps.getMode() !== "plan" || !agent.supportsPlanMode) return undefined;
    if (isMutating(toolCall.name)) {
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
    if (toolCall.name === "run_subagent") {
      if (!isReadOnlySubagentCall(args)) {
        return {
          block: true,
          reason:
            'Plan mode is active — implementing subagents are blocked. Use agent="minimodel" for exploration or agent="maxcoding" with mode="plan" to have it write the plan (read-only), then call submit_plan when your plan is ready.',
        };
      }
      return undefined;
    }
    // A tool the registry marks conditional needs a branch above. Falling
    // through to "allowed" would quietly open a hole in plan mode the next time
    // one is added, so fail closed instead.
    if (CONDITIONAL_PLAN_TOOLS.has(toolCall.name)) {
      return {
        block: true,
        reason: `Plan mode is active — ${toolCall.name} has no plan-mode gate implemented, so it is blocked.`,
      };
    }
    return undefined;
  };

  return {
    session,
    agentSlug: agent.slug,
    builtFrom: agent,
    refreshSystemPrompt: async () => {
      memories = await recentMemories();
      mcpSummary = (await deps.mcp?.promptSummary(agent.mcpServers ?? undefined)) ?? "";
      await loader.reload();
      // The session captures the system prompt at creation; push the rebuilt
      // prompt into live agent state so the next turn sees the current mode.
      session.agent.state.systemPrompt = composeAgentPrompt(
        agent,
        deps.getMode(),
        memories,
        mcpSummary,
      );
    },
    setReasoningEffort,
  };
}
