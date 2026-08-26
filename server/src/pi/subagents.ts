import path from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import type { StreamEvent, UsageSummary } from "@fastcar/shared";
import type { Config } from "../config.js";
import { createWebSearchTool } from "../tools/webSearch.js";
import { createBrowserCheckTool } from "../tools/browserCheck.js";
import { createGitTools, GIT_MUTATING_TOOLS, GIT_TOOL_NAMES } from "../tools/git.js";
import { createMcpTools, MCP_READONLY_TOOL_NAMES } from "../tools/mcp.js";
import type { McpManager } from "../services/mcp.js";
import type { SubagentSettings } from "../services/subagentSettings.js";
import { translateSessionEvent, extractText, extractUsage } from "./events.js";
import { MAXCODING_PLAN_PROMPT, MAXCODING_PROMPT, MINIMODEL_PROMPT } from "./prompts.js";
import { resolveSubagentModel, type FastcarModels } from "./runtime.js";

export type SubagentKind = "maxcoding" | "minimodel";

/**
 * What a subagent run is for. `implement` is the default: maxcoding changes
 * code and verifies it. `plan` is read-only: maxcoding explores and writes an
 * implementation plan plus the questions only the user can answer. minimodel
 * is read-only whichever mode is requested.
 */
export type SubagentMode = "implement" | "plan";

/** True when a run of this kind/mode can never change anything on the VM. */
export function isReadOnlySubagentRun(kind: SubagentKind, mode: SubagentMode | undefined): boolean {
  return kind === "minimodel" || mode === "plan";
}

export interface SubagentRunRequest {
  kind: SubagentKind;
  /** Defaults to "implement". */
  mode?: SubagentMode;
  task: string;
  taskId: string;
  signal: AbortSignal | undefined;
  onEvent: (kind: SubagentKind, taskId: string, ev: StreamEvent) => void;
}

export interface SubagentReport {
  report: string;
  usage: UsageSummary;
}

class Semaphore {
  private queue: Array<() => void> = [];
  private active = 0;
  constructor(private readonly limit: number) {}

  async acquire(): Promise<() => void> {
    if (this.active < this.limit) {
      this.active++;
      return () => this.release();
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
    this.active++;
    return () => this.release();
  }

  private release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }
}

/** Concurrency pools. Planning runs are read-only and cheap, so they get their own, wider pool. */
type PoolKey = "maxcoding" | "maxcoding:plan" | "minimodel";

const READ_ONLY_GIT_TOOLS = GIT_TOOL_NAMES.filter((n) => !GIT_MUTATING_TOOLS.includes(n));

const SUBAGENT_TOOLS: Record<PoolKey, string[]> = {
  // maxcoding gets git except clone and purge — the repository registry's
  // lifecycle stays with the conductor, which can ask the user about it. The
  // same split applies to MCP: it can call installed servers, not install them.
  maxcoding: [
    "read", "bash", "edit", "write", "grep", "find", "ls", "web_search", "browser_check",
    ...GIT_TOOL_NAMES.filter((n) => n !== "git_clone" && n !== "git_purge"),
    ...MCP_READONLY_TOOL_NAMES, "mcp_call",
  ],
  // Planning maxcoding must not be able to change anything — no bash either,
  // since bash can mutate. This is what lets the conductor run it in plan mode.
  "maxcoding:plan": ["read", "grep", "find", "ls", "web_search", ...READ_ONLY_GIT_TOOLS, ...MCP_READONLY_TOOL_NAMES],
  minimodel: ["read", "grep", "find", "ls", "web_search", ...READ_ONLY_GIT_TOOLS, ...MCP_READONLY_TOOL_NAMES],
};

const SUBAGENT_PROMPTS: Record<PoolKey, string> = {
  maxcoding: MAXCODING_PROMPT,
  "maxcoding:plan": MAXCODING_PLAN_PROMPT,
  minimodel: MINIMODEL_PROMPT,
};

function poolKey(kind: SubagentKind, mode: SubagentMode | undefined): PoolKey {
  return kind === "maxcoding" && mode === "plan" ? "maxcoding:plan" : kind;
}

/** Using one of these means the subagent changed something, so it must verify it. */
const MUTATING_TOOLS = ["edit", "write", "bash"];

const VERIFICATION_REMINDER = `Your report is missing the required "## Verification" section, and you changed things.

Verify the work now: find how this project checks itself (package.json scripts, Makefile, pyproject, CI config), install anything missing, and run the relevant tests plus the build/typecheck. Fix what your change broke and run it again.

Reply with the "## Verification" section only: each command verbatim, pass or fail, and the output that matters. If verification is genuinely impossible here, say so explicitly under that heading.`;

/** Lenient on formatting — an unheaded "Verification:" line still counts. */
function hasVerification(report: string): boolean {
  return /^\s*(?:#{1,6}\s*|\*\*)?verification\b/im.test(report);
}

function lastAssistantReport(session: AgentSession): { text: string; usage: UsageSummary } {
  const assistants = session.messages.filter((m) => (m as { role?: string }).role === "assistant");
  const last = assistants[assistants.length - 1];
  if (!last) return { text: "", usage: {} };
  return {
    text: extractText(last as { content?: unknown }),
    usage: extractUsage(last as Parameters<typeof extractUsage>[0]) ?? {},
  };
}

function mergeUsage(a: UsageSummary, b: UsageSummary): UsageSummary {
  const add = (x?: number, y?: number) =>
    x == null && y == null ? undefined : (x ?? 0) + (y ?? 0);
  return {
    model: b.model ?? a.model,
    inputTokens: add(a.inputTokens, b.inputTokens),
    outputTokens: add(a.outputTokens, b.outputTokens),
    cost: add(a.cost, b.cost),
  };
}

export class SubagentManager {
  private semaphores: Record<PoolKey, Semaphore>;
  /**
   * AbortControllers for in-flight subagent runs, keyed by taskId. The
   * conductor's own tool-call signal is forwarded into each controller so a
   * conductor-level abort and an explicit `cancel(taskId)` both reach the
   * underlying agent session.
   */
  private readonly controllers = new Map<string, AbortController>();

  constructor(
    private readonly models: FastcarModels,
    private readonly cfg: Config,
    /** MCP registry; when absent the mcp_* tools are simply not offered. */
    private readonly mcp?: McpManager,
    /** Runtime subagent model settings; absent → use the boot-time models. */
    private readonly subagentSettings?: SubagentSettings,
  ) {
    this.semaphores = {
      maxcoding: new Semaphore(2),
      "maxcoding:plan": new Semaphore(4),
      minimodel: new Semaphore(4),
    };
  }

  /**
   * Abort a running subagent by its taskId. Safe to call when no run is in
   * flight for the id (or after it has finished) — it is a no-op then.
   */
  cancel(taskId: string): void {
    this.controllers.get(taskId)?.abort();
  }

  async run(req: SubagentRunRequest): Promise<SubagentReport> {
    const release = await this.semaphores[poolKey(req.kind, req.mode)].acquire();
    // Create an internal controller so this manager can cancel a run by taskId
    // even when the caller did not supply a signal. If the caller's signal
    // fires, forward it so conductor-driven aborts still propagate.
    const controller = new AbortController();
    const external = req.signal;
    const onExternalAbort = () => controller.abort();
    external?.addEventListener("abort", onExternalAbort);
    // addEventListener does not replay a prior abort, so forward an already-
    // aborted caller signal immediately.
    if (external?.aborted) controller.abort();
    this.controllers.set(req.taskId, controller);
    try {
      return await this.runInner({ ...req, signal: controller.signal });
    } finally {
      external?.removeEventListener("abort", onExternalAbort);
      this.controllers.delete(req.taskId);
      release();
    }
  }

  /**
   * Resolve the Pi model for a subagent kind from the live settings, falling
   * back to the boot-time models[kind] when no settings service is wired in.
   * Re-read on every run so a POST /api/subagent-models is picked up live.
   */
  private resolveModel(kind: SubagentKind): Model<any> {
    const s = this.subagentSettings;
    if (!s) return this.models[kind];
    return resolveSubagentModel(this.models.runtime, this.cfg, kind, {
      provider: s.provider(),
      omlxBaseUrl: s.omlxBaseUrl(),
      model: kind === "maxcoding" ? s.maxcodingModel() : s.minimodelModel(),
    });
  }

  private async runInner(req: SubagentRunRequest): Promise<SubagentReport> {
    const { kind, task, taskId, signal, onEvent } = req;
    const pool = poolKey(kind, req.mode);
    if (signal?.aborted) throw new Error("aborted before start");

    const agentDir = path.join(this.cfg.dataDir, "agent");
    const loader = new DefaultResourceLoader({
      cwd: this.cfg.workdir,
      agentDir,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPromptOverride: () => SUBAGENT_PROMPTS[pool],
    });
    await loader.reload();

    const { session } = await createAgentSession({
      cwd: this.cfg.workdir,
      agentDir,
      modelRuntime: this.models.runtime,
      model: this.resolveModel(kind),
      thinkingLevel: "off",
      tools: SUBAGENT_TOOLS[pool],
      customTools: [
        createWebSearchTool(this.cfg),
        createBrowserCheckTool(this.cfg),
        ...createGitTools(this.cfg),
        ...(this.mcp ? createMcpTools(this.mcp) : []),
      ],
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(this.cfg.workdir),
      settingsManager: SettingsManager.inMemory(),
    });

    const toolsUsed = new Set<string>();
    const unsubscribe = session.subscribe((event) => {
      for (const ev of translateSessionEvent(event)) {
        if (ev.kind === "tool_start") toolsUsed.add(ev.name);
        onEvent(kind, taskId, ev);
      }
    });
    const onAbort = () => void session.abort();
    signal?.addEventListener("abort", onAbort);

    try {
      await session.prompt(`Task: ${task}`);
      if (signal?.aborted) throw new Error("subagent aborted");

      let { text: report, usage } = lastAssistantReport(session);

      // Enforce the verification contract rather than trusting the prompt: a
      // coding agent that changed something and reported no verification gets
      // exactly one follow-up turn to go and run the checks. Planning runs have
      // no mutating tools, so this never fires for them.
      const changedSomething = MUTATING_TOOLS.some((t) => toolsUsed.has(t));
      if (pool === "maxcoding" && changedSomething && !hasVerification(report)) {
        await session.prompt(VERIFICATION_REMINDER);
        if (signal?.aborted) throw new Error("subagent aborted");
        const followUp = lastAssistantReport(session);
        if (followUp.text) {
          report = `${report}\n\n${followUp.text}`;
          usage = mergeUsage(usage, followUp.usage);
        }
      }

      return { report: report || "(subagent produced no report)", usage };
    } finally {
      signal?.removeEventListener("abort", onAbort);
      unsubscribe();
      session.dispose();
    }
  }
}
