import path from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import type { StreamEvent, UsageSummary } from "@fastcar/shared";
import type { Config } from "../config.js";
import { createWebSearchTool } from "../tools/webSearch.js";
import { createBrowserCheckTool } from "../tools/browserCheck.js";
import { createGitTools, GIT_TOOL_NAMES } from "../tools/git.js";
import { translateSessionEvent, extractText, extractUsage } from "./events.js";
import { MAXCODING_PROMPT, MINIMODEL_PROMPT } from "./prompts.js";
import type { FastcarModels } from "./runtime.js";

export type SubagentKind = "maxcoding" | "minimodel";

export interface SubagentRunRequest {
  kind: SubagentKind;
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

const SUBAGENT_TOOLS: Record<SubagentKind, string[]> = {
  // maxcoding gets git except clone and purge — the repository registry's
  // lifecycle stays with the conductor, which can ask the user about it.
  maxcoding: [
    "read", "bash", "edit", "write", "grep", "find", "ls", "web_search", "browser_check",
    ...GIT_TOOL_NAMES.filter((n) => n !== "git_clone" && n !== "git_purge"),
  ],
  minimodel: ["read", "grep", "find", "ls", "web_search", "git_status", "git_list_repos"],
};

const SUBAGENT_PROMPTS: Record<SubagentKind, string> = {
  maxcoding: MAXCODING_PROMPT,
  minimodel: MINIMODEL_PROMPT,
};

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
  private semaphores: Record<SubagentKind, Semaphore>;
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
  ) {
    this.semaphores = {
      maxcoding: new Semaphore(2),
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
    const release = await this.semaphores[req.kind].acquire();
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

  private async runInner(req: SubagentRunRequest): Promise<SubagentReport> {
    const { kind, task, taskId, signal, onEvent } = req;
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
      systemPromptOverride: () => SUBAGENT_PROMPTS[kind],
    });
    await loader.reload();

    const { session } = await createAgentSession({
      cwd: this.cfg.workdir,
      agentDir,
      modelRuntime: this.models.runtime,
      model: this.models[kind],
      thinkingLevel: "off",
      tools: SUBAGENT_TOOLS[kind],
      customTools: [
        createWebSearchTool(this.cfg),
        createBrowserCheckTool(this.cfg),
        ...createGitTools(this.cfg),
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
      // exactly one follow-up turn to go and run the checks.
      const changedSomething = MUTATING_TOOLS.some((t) => toolsUsed.has(t));
      if (kind === "maxcoding" && changedSomething && !hasVerification(report)) {
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
