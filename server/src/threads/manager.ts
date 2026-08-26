import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type {
  AgentName,
  PendingInteraction,
  PromptThreadConfig,
  ServerMessage,
  StreamEvent,
  ThreadMeta,
  ThreadMode,
  ThreadStatus,
  ReasoningEffort,
} from "@fastcar/shared";
import type { Config } from "../config.js";
import { insertEvents, maxSeq, type EventInsert } from "../db/events.js";
import * as threadsDb from "../db/threads.js";
import type { ThreadRecord } from "../db/threads.js";
import { toMeta } from "../db/threads.js";
import { createConductorSession, type ConductorHandle } from "../pi/conductor.js";
import { appSettingsEvents, type AppSettings } from "../services/appSettings.js";
import { collectRepoStatuses, gitEvents } from "../services/git.js";
import { mcpEvents, type McpManager } from "../services/mcp.js";
import { expandMentions } from "../services/mentions.js";
import { translateSessionEvent } from "../pi/events.js";
import type { FastcarModels } from "../pi/runtime.js";
import type { SubagentKind, SubagentManager } from "../pi/subagents.js";
import { completePrompt } from "../services/llmService.js";
import { getPromptTemplate, resolveTemplate } from "../services/promptTemplates.js";
import { RateLimiter, postToWebhook, validateWebhookUrl } from "../services/webhook.js";
import { WebhookTokenStore, generateTriggerToken } from "../services/webhookTokens.js";
import type { EmailService } from "../services/emailService.js";
import { artifactEvents, type ArtifactService } from "../services/artifacts.js";
import { findCommand, parseCommandLine, runCommand } from "./commands.js";

type Broadcast = (msg: ServerMessage) => void;

/** Canonical public path prefix for triggering a prompt thread (no auth). Keep in sync with deploy/fastcar.json `auth.public_paths`. */
export const PUBLIC_PROMPT_TRIGGER_PREFIX = "/pt/";

interface PendingQuestion {
  questionId: string;
  resolve: (answer: string) => void;
  reject: (err: Error) => void;
}

interface ThreadRuntime {
  id: string;
  mode: ThreadMode;
  status: ThreadStatus;
  title: string;
  conductor: ConductorHandle | null;
  seq: number;
  /** Complete items staged for the PG flush at agent_end. */
  staged: EventInsert[];
  /** In-flight event insert, if any — deletion waits for it to land. */
  flushing: Promise<void> | null;
  pendingQuestion: PendingQuestion | null;
  /** Serializes state-changing work on this thread; see `enqueue`. */
  queue: Promise<unknown>;
  submittedPlan: string | null;
  /** Rolling text of the current assistant message, for title + plan fallback. */
  lastAssistantText: string;
  creating: Promise<ConductorHandle> | null;
  /** The thread is gone: a run still unwinding must not write or broadcast. */
  deleted: boolean;
}

const DELTA_COALESCE_MS = 30;

export class ThreadManager {
  private runtimes = new Map<string, ThreadRuntime>();
  private runtimeLoads = new Map<string, Promise<ThreadRuntime>>();
  private clients = new Set<Broadcast>();
  private deltaBuffers = new Map<string, { agent: AgentName; taskId?: string; kind: "text_delta" | "thinking_delta"; text: string }>();
  private deltaTimer: NodeJS.Timeout | null = null;
  private readonly webhookTokens: WebhookTokenStore;
  private readonly webhookLimiter = new RateLimiter(10, 60_000);
  /** Per-thread rate limit for public prompt triggers (5 calls / 60s). */
  private readonly triggerLimiter = new RateLimiter(5, 60_000);

  constructor(
    private readonly cfg: Config,
    private readonly models: FastcarModels,
    private readonly subagents: SubagentManager,
    private readonly email?: EmailService,
    private readonly artifacts?: ArtifactService,
    private readonly mcp?: McpManager,
    private readonly settings?: AppSettings,
  ) {
    this.webhookTokens = new WebhookTokenStore(cfg);
    appSettingsEvents.on("changed", () => this.onSettingsChanged());
    gitEvents.on("changed", () => void this.broadcastRepos());
    mcpEvents.on("changed", () => void this.onMcpChanged());
    artifactEvents.on("changed", (threadId) => this.broadcast({ type: "artifacts_updated", threadId }));
  }

  async broadcastRepos(): Promise<void> {
    try {
      const repos = await collectRepoStatuses();
      this.broadcast({ type: "repos_updated", repos });
    } catch (err) {
      console.error("failed to collect repo statuses:", err);
    }
  }

  /** The conductor's reasoning effort follows the ⚙ setting, live sessions included. */
  private onSettingsChanged(): void {
    const effort = this.conductorReasoningEffort();
    for (const rt of this.runtimes.values()) {
      rt.conductor?.setReasoningEffort(effort);
    }
  }

  private conductorReasoningEffort(): ReasoningEffort {
    return this.settings?.conductorReasoningEffort() ?? this.cfg.conductorReasoningEffort;
  }

  /**
   * MCP servers changed (installed, removed, connected, died): tell the UI, and
   * rebuild every live conductor's system prompt so the next turn lists the
   * current servers and tools.
   */
  private async onMcpChanged(): Promise<void> {
    if (!this.mcp) return;
    try {
      this.broadcast({ type: "mcp_servers_updated", servers: await this.mcp.statuses() });
    } catch (err) {
      console.error("failed to collect MCP statuses:", err);
    }
    for (const rt of this.runtimes.values()) {
      await rt.conductor?.refreshSystemPrompt().catch((err) => {
        console.error(`failed to refresh prompt for thread ${rt.id}:`, err);
      });
    }
  }

  /**
   * "Add repository" from the UI: routed through the conductor so the clone is
   * visible (and steerable) in a thread like any other agent action.
   */
  async addRepo(url: string, name: string | undefined, threadId: string | undefined): Promise<void> {
    let targetId = threadId;
    if (targetId) {
      const rt = await this.getRuntime(targetId);
      if (rt.status !== "idle" || rt.mode !== "act") targetId = undefined;
    }
    if (!targetId) {
      const meta = await this.createThread("act");
      targetId = meta.id;
    }
    const nameNote = name ? ` and register it under the name "${name}"` : "";
    await this.prompt(
      targetId,
      `Add the git repository ${url} to this VM: clone it with git_clone${nameNote}, then report the registered name, path, and default branch.`,
    );
  }

  // ---------------------------------------------------------------- clients

  addClient(send: Broadcast): () => void {
    this.clients.add(send);
    return () => this.clients.delete(send);
  }

  private broadcast(msg: ServerMessage): void {
    for (const send of this.clients) {
      try {
        send(msg);
      } catch {
        // client cleanup happens in the ws handler
      }
    }
  }

  // ---------------------------------------------------------------- threads

  /**
   * Public, unauthenticated trigger URL for a prompt thread:
   * `<publicUrl>/pt/<threadId>`. Returns null for chat threads (no trigger).
   */
  threadPublicUrl(threadId: string): string | null {
    return `${this.cfg.publicUrl}${PUBLIC_PROMPT_TRIGGER_PREFIX}${threadId}`;
  }

  /**
   * Wrap `toMeta()` and add the public trigger URL for prompt threads. The URL
   * is the capability that lets an unauthenticated caller re-run the thread via
   * `/pt/<id>`; chat threads get `null` so the UI can hide the trigger affordance.
   */
  private enrichMeta(rec: ThreadRecord): ThreadMeta {
    const meta = toMeta(rec);
    meta.publicUrl = rec.threadType === "prompt" ? this.threadPublicUrl(rec.id) : null;
    return meta;
  }

  async createThread(mode: ThreadMode = "act"): Promise<ThreadMeta> {
    const rec = await threadsDb.createThread(mode);
    const meta = this.enrichMeta(rec);
    this.broadcast({ type: "thread_created", thread: meta });
    return meta;
  }

  /**
   * Create a prompt thread (Feature 3): resolve the template, substitute
   * variables, run the LLM, POST the result to the webhook, and record the
   * delivery status in the thread history.
   */
  async createPromptThread(opts: {
    title?: string;
    templateId: string;
    variables?: Record<string, string>;
    webhookUrl: string;
    webhookToken: string;
  }): Promise<ThreadMeta> {
    const template = getPromptTemplate(opts.templateId);
    if (!template) throw new Error(`no such prompt template: ${opts.templateId}`);
    const validation = validateWebhookUrl(opts.webhookUrl);
    if (!validation.ok) throw new Error(`webhook URL invalid: ${validation.reason}`);

    const rate = this.webhookLimiter.check(opts.webhookUrl);
    if (!rate.allowed) {
      throw new Error(
        `webhook rate limit exceeded for ${opts.webhookUrl}; retry in ${Math.ceil((rate.retryAfterMs ?? 0) / 1000)}s`,
      );
    }

    const promptText = resolveTemplate(template, opts.variables ?? {});
    const rec = await threadsDb.createThread("act", "prompt");
    const threadId = rec.id;
    this.webhookTokens.set(threadId, opts.webhookToken);
    // Mint a trigger token so the public `/pt/<id>` endpoint can re-run this
    // thread; the token is the URL capability (never sent back over the wire
    // except via the admin-owned create response below).
    const triggerToken = generateTriggerToken();
    this.webhookTokens.setTriggerToken(threadId, triggerToken);

    const config: PromptThreadConfig = {
      templateId: template.id,
      webhookUrl: opts.webhookUrl,
      webhookTokenSet: Boolean(opts.webhookToken),
      webhookStatus: "pending",
      variables: opts.variables ?? {},
    };
    const titled = await threadsDb.updateThread(threadId, {
      title: opts.title?.trim() || `Prompt: ${template.id}`,
      promptConfig: config,
    });
    if (titled) this.broadcast({ type: "thread_created", thread: this.enrichMeta(titled) });

    // Record the resolved prompt as the user message that started this thread.
    const rt = await this.getRuntime(threadId);
    this.stageAndSend(rt, "conductor", undefined, {
      kind: "user_message",
      text: `Prompt thread (template: ${template.id}):\n\n${promptText}`,
    });
    await this.flushStaged(rt);

    // Fire the generation + delivery asynchronously so the create call returns.
    void this.runPromptThreadDelivery(threadId, promptText).catch((err) => {
      console.error(`prompt thread ${threadId} delivery failed:`, err);
    });

    return titled ? this.enrichMeta(titled) : this.enrichMeta(rec);
  }

  private async runPromptThreadDelivery(threadId: string, promptText: string): Promise<void> {
    const rt = await this.getRuntime(threadId);
    let response = "";
    let delivery: { ok: boolean; status: "success" | "error" | "skipped"; response: string };
    try {
      response = await completePrompt(this.models, promptText);
      this.stageAndSend(rt, "conductor", undefined, { kind: "message_end", text: response });
      await this.flushStaged(rt);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.stageAndSend(rt, "conductor", undefined, {
        kind: "error",
        message: `LLM generation failed: ${message}`,
      });
      await this.flushStaged(rt);
      delivery = { ok: false, status: "error", response: `LLM generation failed: ${message}` };
      await this.recordPromptDelivery(threadId, delivery);
      this.broadcast({ type: "prompt_thread_result", threadId, status: "error", response: delivery.response });
      return;
    }

    const rec = await threadsDb.getThread(threadId);
    const url = rec?.promptConfig?.webhookUrl ?? "";
    const token = this.webhookTokens.get(threadId);
    if (!url || !token) {
      delivery = { ok: false, status: "skipped", response: "no webhook url/token set" };
    } else {
      delivery = await postToWebhook(url, token, { threadId, prompt: promptText, response }, undefined);
    }
    await this.recordPromptDelivery(threadId, delivery);
    this.broadcast({
      type: "prompt_thread_result",
      threadId,
      status: delivery.status,
      response: delivery.response,
    });
  }

  private async recordPromptDelivery(
    threadId: string,
    delivery: { ok: boolean; status: "success" | "error" | "skipped"; response: string },
  ): Promise<void> {
    const rt = this.runtimes.get(threadId);
    if (rt) {
      const label =
        delivery.status === "success"
          ? `✅ Webhook delivered. ${delivery.response}`
          : delivery.status === "skipped"
            ? `⏭️ Webhook skipped: ${delivery.response}`
            : `❌ Webhook failed: ${delivery.response}`;
      this.stageAndSend(rt, "conductor", undefined, { kind: "system", text: label });
      await this.flushStaged(rt);
    }
    const rec = await threadsDb.getThread(threadId);
    if (rec?.promptConfig) {
      const next: PromptThreadConfig = {
        ...rec.promptConfig,
        webhookStatus: delivery.status,
        webhookResponse: delivery.response,
      };
      await threadsDb.updateThread(threadId, { promptConfig: next });
    }
  }

  /**
   * Publicly re-trigger a prompt thread via its `/pt/<id>` capability URL.
   *
   * Validates the thread exists and is a prompt thread, compares the supplied
   * token against the stored trigger token in constant time, rate-limits per
   * thread, then re-resolves the template with the stored variables and re-runs
   * the delivery. Returns the delivery outcome so the public endpoint can map
   * it to an HTTP status without exposing internals.
   */
  async triggerPromptThread(
    threadId: string,
    token: string,
  ): Promise<{ status: "accepted" | "error" | "not_found" | "unauthorized" | "rate_limited"; message?: string }> {
    const rec = await threadsDb.getThread(threadId);
    if (!rec) return { status: "not_found" };
    if (rec.threadType !== "prompt") return { status: "not_found" };

    // Constant-time comparison: a mismatched token must not leak how far the
    // stored token matched. Empty stored token => no trigger configured.
    const stored = this.webhookTokens.getTriggerToken(threadId);
    if (!stored || !token || !timingSafeEqualString(token, stored)) {
      return { status: "unauthorized" };
    }

    const rate = this.triggerLimiter.check(threadId);
    if (!rate.allowed) {
      return {
        status: "rate_limited",
        message: `rate limit exceeded; retry in ${Math.ceil((rate.retryAfterMs ?? 0) / 1000)}s`,
      };
    }

    const config = rec.promptConfig;
    if (!config) return { status: "error", message: "prompt thread has no config" };
    const template = getPromptTemplate(config.templateId);
    if (!template) return { status: "error", message: `no such prompt template: ${config.templateId}` };

    const promptText = resolveTemplate(template, config.variables ?? {});
    // Fire-and-forget like the create path; the result lands via the usual
    // prompt_thread_result broadcast and the thread history.
    void this.runPromptThreadDelivery(threadId, promptText).catch((err) => {
      console.error(`prompt thread ${threadId} trigger delivery failed:`, err);
    });
    return { status: "accepted" };
  }

  async renameThread(threadId: string, title: string): Promise<void> {
    await this.applyTitle(this.runtimes.get(threadId) ?? null, threadId, title);
  }

  private async applyTitle(
    rt: ThreadRuntime | null,
    threadId: string,
    title: string,
  ): Promise<string> {
    const clean = title.trim().replace(/\s+/g, " ").slice(0, 200);
    if (!clean) throw new Error("a thread title cannot be empty");
    const rec = await threadsDb.updateThread(threadId, { title: clean });
    if (!rec) throw new Error(`no such thread: ${threadId}`);
    // Keep the runtime in step so auto-titling never overwrites a chosen name.
    if (rt) rt.title = clean;
    this.broadcast({ type: "thread_updated", thread: this.enrichMeta(rec) });
    return clean;
  }

  /**
   * Delete a thread outright: stop any run, drop the agent session and its
   * JSONL file, and remove the row (events cascade). Not recoverable.
   */
  async deleteThread(threadId: string): Promise<void> {
    const rec = await threadsDb.getThread(threadId);
    if (!rec) throw new Error(`no such thread: ${threadId}`);

    const rt = this.runtimes.get(threadId);
    if (rt) {
      // Set first: an in-flight run unwinds through finishRun, which must not
      // insert events for a row that is about to disappear.
      rt.deleted = true;
      rt.staged = [];
      rt.pendingQuestion?.reject(new Error("thread deleted"));
      rt.pendingQuestion = null;
      await rt.conductor?.session.abort().catch(() => {});
      rt.conductor?.session.dispose();
      // An event insert already on its way to PG must land before the row goes,
      // or it fails the foreign key on a thread that no longer exists.
      await rt.flushing;
      this.runtimes.delete(threadId);
    }

    await threadsDb.deleteThread(threadId);
    this.removeSessionFile(rec.piSessionFile);
    // Drop both the webhook bearer token and the public trigger token so a
    // stale capability URL can no longer fire the (now-deleted) thread.
    this.webhookTokens.delete(threadId);
    this.webhookTokens.deleteTriggerToken(threadId);
    this.broadcast({ type: "thread_deleted", threadId });
  }

  /** Only ever unlinks inside the app's own session directory. */
  private removeSessionFile(file: string | null): void {
    if (!file) return;
    const abs = path.resolve(file);
    const rel = path.relative(path.resolve(this.cfg.sessionDir), abs);
    if (rel.startsWith("..") || path.isAbsolute(rel)) return;
    void fs.promises.rm(abs, { force: true }).catch((err) => {
      console.error(`failed to remove session file ${abs}:`, err);
    });
  }

  async setMode(threadId: string, mode: ThreadMode): Promise<void> {
    const rt = await this.getRuntime(threadId);
    if (rt.status !== "idle") throw new Error("cannot change mode while the agent is busy");
    await this.applyMode(rt, mode);
  }

  /**
   * `emit: false` defers the broadcast to the caller — a command must not
   * announce its state change before it has finished, or a client can act on
   * the new state while the command still holds the thread.
   */
  private async applyMode(rt: ThreadRuntime, mode: ThreadMode, emit = true): Promise<void> {
    rt.mode = mode;
    await threadsDb.updateThread(rt.id, { mode });
    await rt.conductor?.refreshSystemPrompt();
    if (emit) await this.emitStatus(rt);
  }

  // ---------------------------------------------------------------- prompt

  async prompt(threadId: string, text: string): Promise<void> {
    const rt = await this.getRuntime(threadId);
    return this.enqueue(rt, () => this.startPrompt(rt, text));
  }

  private async startPrompt(rt: ThreadRuntime, text: string): Promise<void> {
    this.assertAcceptsWork(rt);

    // A slash command may arrive as ordinary prompt text (pasted, or from a
    // non-browser client). Only intercept names the registry actually knows, so
    // a message that merely starts with a path stays a prompt. Call the inner
    // form: we already hold the thread's queue slot.
    const parsed = parseCommandLine(text);
    if (parsed && findCommand(parsed.name)) {
      return this.runSlashCommand(rt, parsed.name, parsed.args);
    }

    const conductor = await this.ensureConductor(rt);
    rt.status = "running";
    await threadsDb.updateThread(rt.id, { status: "running" });
    await this.emitStatus(rt);

    this.stageAndSend(rt, "conductor", undefined, { kind: "user_message", text });
    // user_message rows are not tied to agent_end; flush immediately so a
    // crash mid-run still keeps the user's prompt in history.
    await this.flushStaged(rt);

    // The transcript keeps the mentions as typed; the model gets them resolved.
    void this.runPrompt(rt, conductor, await expandMentions(this.cfg, text));
  }

  /** Shared entry guard for anything that starts new work on a thread. */
  private assertAcceptsWork(rt: ThreadRuntime): void {
    if (rt.status === "running") throw new Error("agent is already running — use steer");
    if (rt.status === "awaiting_input") throw new Error("answer the pending question first");
    if (rt.status === "awaiting_approval")
      throw new Error("approve or reject the pending plan first");
  }

  // ---------------------------------------------------------------- commands

  /**
   * Send an email directly (no thread context) — used by the `/email` slash
   * command when no threadId is provided. Returns the send result.
   */
  async sendEmailDirect(
    to: string,
    subject: string,
    body: string,
  ): Promise<{ ok: boolean; message: string; messageId?: string }> {
    if (!this.email) return { ok: false, message: "email service is not available" };
    return this.email.sendEmail(to, subject, body);
  }

  /**
   * Run a slash command and render its output into the thread. Commands never
   * reach the model: they read app state, or drive the thread directly.
   */
  async command(threadId: string, name: string, args = ""): Promise<void> {
    const rt = await this.getRuntime(threadId);
    return this.enqueue(rt, () => this.runSlashCommand(rt, name, args));
  }

  /**
   * Structured `/email` slash command (Feature 2): send an email via the
   * configured SMTP server and report success/failure into the thread.
   */
  async emailSlash(
    threadId: string,
    args: { to: string; subject: string; body: string },
  ): Promise<void> {
    if (!this.email) throw new Error("email service is not available");
    const email = this.email;
    const rt = await this.getRuntime(threadId);
    return this.enqueue(rt, async () => {
      this.assertAcceptsWork(rt);
      this.stageAndSend(rt, "conductor", undefined, {
        kind: "user_message",
        text: `/email to=${args.to} subject=${args.subject}`,
      });
      const result = await email.sendEmail(args.to, args.subject, args.body);
      const text = result.ok
        ? `✅ Email sent to ${args.to}${result.messageId ? ` (messageId: ${result.messageId})` : ""}.`
        : `❌ Email failed: ${result.message}`;
      this.stageAndSend(rt, "conductor", undefined, { kind: "system", text });
      await this.flushStaged(rt);
    });
  }

  /** Must run inside the thread's queue slot. */
  private async runSlashCommand(rt: ThreadRuntime, name: string, args: string): Promise<void> {
    this.assertAcceptsWork(rt);

    const line = `/${name}${args ? ` ${args}` : ""}`;
    this.stageAndSend(rt, "conductor", undefined, { kind: "user_message", text: line });

    let modeChanged = false;
    try {
      const output = await runCommand(name, {
        cfg: this.cfg,
        threadId: rt.id,
        args,
        mode: rt.mode,
        session: rt.conductor?.session ?? null,
        setMode: async (mode) => {
          await this.applyMode(rt, mode, false);
          modeChanged = true;
        },
        rename: (title) => this.applyTitle(rt, rt.id, title),
        mcp: this.mcp,
      });
      this.stageAndSend(rt, "conductor", undefined, { kind: "system", text: output });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.stageAndSend(rt, "conductor", undefined, { kind: "error", message: `${line}: ${message}` });
    } finally {
      await this.flushStaged(rt);
      if (modeChanged) await this.emitStatus(rt);
    }
  }

  private async runPrompt(rt: ThreadRuntime, conductor: ConductorHandle, text: string): Promise<void> {
    try {
      await conductor.session.prompt(text);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.stageAndSend(rt, "conductor", undefined, { kind: "error", message });
    } finally {
      await this.finishRun(rt);
    }
  }

  private async finishRun(rt: ThreadRuntime): Promise<void> {
    this.flushDeltas();
    await this.flushStaged(rt);
    if (rt.deleted) return;

    if (rt.mode === "plan" && (rt.submittedPlan !== null || this.looksLikePlan(rt))) {
      const plan = rt.submittedPlan ?? rt.lastAssistantText;
      rt.submittedPlan = null;
      rt.status = "awaiting_approval";
      const pending: PendingInteraction = { kind: "plan", planMarkdown: plan };
      await threadsDb.updateThread(rt.id, { status: rt.status, pending });
      this.stageAndSend(rt, "conductor", undefined, { kind: "plan", planMarkdown: plan });
      await this.flushStaged(rt);
      this.broadcast({ type: "plan_ready", threadId: rt.id, planMarkdown: plan });
    } else {
      rt.status = "idle";
      await threadsDb.updateThread(rt.id, { status: "idle", pending: null });
    }
    await this.emitStatus(rt);
    await this.maybeAutoTitle(rt);
  }

  private looksLikePlan(rt: ThreadRuntime): boolean {
    // Fallback: the model ended a plan-mode turn without calling submit_plan
    // but produced a substantial final message — treat it as the plan so the
    // UI never dead-ends.
    return rt.lastAssistantText.trim().length > 80;
  }

  // ---------------------------------------------------------------- steer / abort

  async steer(threadId: string, text: string): Promise<void> {
    // Steering commands drive subagent control directly, bypassing the model.
    // Only `cancel <taskId>` is recognized for now; anything else is forwarded
    // to the conductor as ordinary steering input.
    const match = /^\s*cancel\s+(\S+)\s*$/i.exec(text);
    if (match) {
      const taskId = match[1]!;
      this.subagents.cancel(taskId);
      const rt = this.runtimes.get(threadId);
      if (rt) {
        this.stageAndSend(rt, "conductor", undefined, {
          kind: "system",
          text: `Steering: cancelled subagent task ${taskId}.`,
        });
        await this.flushStaged(rt);
      }
      return;
    }

    const rt = this.runtimes.get(threadId);
    if (!rt?.conductor || rt.status !== "running") throw new Error("agent is not running");
    this.stageAndSend(rt, "conductor", undefined, { kind: "user_message", text: `(steer) ${text}` });
    await rt.conductor.session.steer(await expandMentions(this.cfg, text));
  }

  async abort(threadId: string): Promise<void> {
    const rt = this.runtimes.get(threadId);
    if (!rt) return;
    rt.pendingQuestion?.reject(new Error("aborted by user"));
    rt.pendingQuestion = null;
    await rt.conductor?.session.abort();
  }

  // ---------------------------------------------------------------- questions

  async answerQuestion(threadId: string, questionId: string, answer: string): Promise<void> {
    const rt = this.runtimes.get(threadId);
    if (!rt?.pendingQuestion || rt.pendingQuestion.questionId !== questionId) {
      throw new Error("no matching pending question");
    }
    const pending = rt.pendingQuestion;
    rt.pendingQuestion = null;
    rt.status = "running";
    await threadsDb.updateThread(threadId, { status: "running", pending: null });
    this.stageAndSend(rt, "conductor", undefined, { kind: "answer", questionId, text: answer });
    await this.emitStatus(rt);
    pending.resolve(answer);
  }

  // ---------------------------------------------------------------- plans

  async approvePlan(threadId: string): Promise<void> {
    const rt = await this.getRuntime(threadId);
    if (rt.status !== "awaiting_approval") throw new Error("no plan awaiting approval");
    const rec = await threadsDb.getThread(threadId);
    const plan = rec?.pending?.kind === "plan" ? rec.pending.planMarkdown : rt.lastAssistantText;

    rt.mode = "act";
    rt.status = "running";
    await threadsDb.updateThread(threadId, { mode: "act", status: "running", pending: null });
    const conductor = await this.ensureConductor(rt);
    await conductor.refreshSystemPrompt();
    await this.emitStatus(rt);

    const text = `The user approved your plan. Execute it now.\n\nApproved plan:\n${plan}`;
    this.stageAndSend(rt, "conductor", undefined, { kind: "user_message", text: "✅ Plan approved — executing." });
    void this.runPrompt(rt, conductor, text);
  }

  async rejectPlan(threadId: string, feedback: string): Promise<void> {
    const rt = await this.getRuntime(threadId);
    if (rt.status !== "awaiting_approval") throw new Error("no plan awaiting approval");
    rt.status = "running";
    await threadsDb.updateThread(threadId, { status: "running", pending: null });
    const conductor = await this.ensureConductor(rt);
    await this.emitStatus(rt);

    const text = `The user did not approve the plan. Revise it and submit again with submit_plan.\n\nFeedback:\n${feedback}`;
    this.stageAndSend(rt, "conductor", undefined, {
      kind: "user_message",
      text: `❌ Plan rejected: ${feedback}`,
    });
    void this.runPrompt(rt, conductor, text);
  }

  // ---------------------------------------------------------------- conductor wiring

  /**
   * Serialize state-changing work on one thread. Every WS frame is handled in
   * its own async task (and several clients can drive the same thread), so
   * without this two prompts or commands interleave at their first await and
   * see each other's half-applied state.
   */
  private enqueue<T>(rt: ThreadRuntime, work: () => Promise<T>): Promise<T> {
    const next = rt.queue.then(work, work);
    rt.queue = next.catch(() => undefined);
    return next;
  }

  private async getRuntime(threadId: string): Promise<ThreadRuntime> {
    const existing = this.runtimes.get(threadId);
    if (existing) return existing;
    // Concurrent first touches of the same thread must share one runtime, or
    // the queue above would serialize against two different objects.
    const loading = this.runtimeLoads.get(threadId) ?? this.loadRuntime(threadId);
    this.runtimeLoads.set(threadId, loading);
    try {
      return await loading;
    } finally {
      this.runtimeLoads.delete(threadId);
    }
  }

  private async loadRuntime(threadId: string): Promise<ThreadRuntime> {
    const rec = await threadsDb.getThread(threadId);
    if (!rec) throw new Error(`no such thread: ${threadId}`);
    const rt: ThreadRuntime = {
      id: threadId,
      mode: rec.mode,
      status: rec.status,
      title: rec.title,
      conductor: null,
      seq: await maxSeq(threadId),
      staged: [],
      flushing: null,
      pendingQuestion: null,
      queue: Promise.resolve(),
      submittedPlan: null,
      lastAssistantText: "",
      creating: null,
      deleted: false,
    };
    this.runtimes.set(threadId, rt);
    return rt;
  }

  private async ensureConductor(rt: ThreadRuntime): Promise<ConductorHandle> {
    if (rt.conductor) return rt.conductor;
    if (rt.creating) return rt.creating;

    rt.creating = (async () => {
      const rec = await threadsDb.getThread(rt.id);
      const handle = await createConductorSession({
        cfg: this.cfg,
        models: this.models,
        subagents: this.subagents,
        threadId: rt.id,
        getMode: () => rt.mode,
        askBridge: {
          ask: (toolCallId, question, options, signal) =>
            this.askUser(rt, toolCallId, question, options, signal),
        },
        planBridge: {
          submit: (plan) => {
            rt.submittedPlan = plan;
          },
        },
        onSubagentEvent: (kind, taskId, ev) => this.onSubagentEvent(rt, kind, taskId, ev),
        email: this.email,
        artifacts: this.artifacts,
        mcp: this.mcp,
        sessionFile: rec?.piSessionFile ?? null,
        reasoningEffort: this.conductorReasoningEffort(),
      });

      handle.session.subscribe((event) => {
        for (const ev of translateSessionEvent(event)) {
          this.onConductorEvent(rt, ev);
        }
      });

      if (!rec?.piSessionFile && handle.session.sessionFile) {
        await threadsDb.updateThread(rt.id, { piSessionFile: handle.session.sessionFile });
      }
      rt.conductor = handle;
      return handle;
    })();

    try {
      return await rt.creating;
    } finally {
      rt.creating = null;
    }
  }

  private askUser(
    rt: ThreadRuntime,
    toolCallId: string,
    question: string,
    options: string[] | undefined,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const questionId = toolCallId;
      rt.pendingQuestion = { questionId, resolve, reject };
      rt.status = "awaiting_input";
      const pending: PendingInteraction = { kind: "question", questionId, prompt: question, options };
      this.stageAndSend(rt, "conductor", undefined, { kind: "question", questionId, prompt: question, options });

      void threadsDb
        .updateThread(rt.id, { status: "awaiting_input", pending })
        .then(() => this.emitStatus(rt))
        .then(() => this.flushStaged(rt));

      this.broadcast({ type: "question", threadId: rt.id, questionId, prompt: question, options });

      signal?.addEventListener("abort", () => {
        if (rt.pendingQuestion?.questionId === questionId) {
          rt.pendingQuestion = null;
          reject(new Error("question aborted"));
        }
      });
    });
  }

  // ---------------------------------------------------------------- event plumbing

  private onConductorEvent(rt: ThreadRuntime, ev: StreamEvent): void {
    if (ev.kind === "message_end") rt.lastAssistantText = ev.text;
    this.stageAndSend(rt, "conductor", undefined, ev);
  }

  private onSubagentEvent(rt: ThreadRuntime, kind: SubagentKind, taskId: string, ev: StreamEvent): void {
    // Persist only substantial subagent items; forward everything live.
    this.stageAndSend(rt, kind, taskId, ev, {
      persist: ev.kind === "message_end" || ev.kind === "tool_start" || ev.kind === "tool_end",
    });
  }

  /** Translate a StreamEvent into (a) a live WS broadcast and (b) a staged PG row. */
  private stageAndSend(
    rt: ThreadRuntime,
    agent: AgentName,
    taskId: string | undefined,
    ev: StreamEvent,
    opts: { persist?: boolean } = {},
  ): void {
    if (rt.deleted) return;
    const persist = opts.persist ?? true;

    if (ev.kind === "text_delta" || ev.kind === "thinking_delta") {
      this.bufferDelta(rt, agent, taskId, ev);
      return; // deltas are never persisted
    }

    this.flushDeltas();
    const row = this.toRow(rt, agent, taskId, ev);
    if (persist && row) {
      rt.seq += 1;
      row.seq = rt.seq;
      rt.staged.push(row);
      this.broadcast({ type: "event", threadId: rt.id, seq: rt.seq, agent, taskId, ev });
    } else {
      this.broadcast({ type: "event", threadId: rt.id, seq: -1, agent, taskId, ev });
    }
  }

  private toRow(
    rt: ThreadRuntime,
    agent: AgentName,
    taskId: string | undefined,
    ev: StreamEvent,
  ): EventInsert | null {
    const base = { threadId: rt.id, seq: 0, agent, taskId: taskId ?? null };
    switch (ev.kind) {
      case "user_message":
        return { ...base, kind: "user_message", payload: { text: ev.text } };
      case "system":
        return { ...base, kind: "system", payload: { text: ev.text } };
      case "message_end":
        if (!ev.text && !ev.thinking) return null;
        return {
          ...base,
          kind: "assistant_text",
          payload: { text: ev.text, thinking: ev.thinking, usage: ev.usage },
        };
      case "tool_start":
        return {
          ...base,
          kind: "tool_call",
          payload: { phase: "start", toolCallId: ev.toolCallId, name: ev.name, args: ev.args },
        };
      case "tool_end":
        return {
          ...base,
          kind: "tool_call",
          payload: { phase: "end", toolCallId: ev.toolCallId, ok: ev.ok, result: truncate(ev.result, 20_000) },
        };
      case "question":
        return { ...base, kind: "question", payload: { questionId: ev.questionId, prompt: ev.prompt, options: ev.options } };
      case "answer":
        return { ...base, kind: "answer", payload: { questionId: ev.questionId, text: ev.text } };
      case "plan":
        return { ...base, kind: "plan", payload: { planMarkdown: ev.planMarkdown } };
      case "error":
        return { ...base, kind: "error", payload: { message: ev.message } };
      default:
        return null; // message_start, tool_update, deltas: live-only
    }
  }

  private async flushStaged(rt: ThreadRuntime): Promise<void> {
    if (rt.deleted || !rt.staged.length) return;
    const batch = rt.staged;
    rt.staged = [];
    const write = insertEvents(batch).catch((err) => {
      console.error(`failed to persist events for thread ${rt.id}:`, err);
    });
    rt.flushing = write;
    await write;
    if (rt.flushing === write) rt.flushing = null;
  }

  // Delta coalescing: buffer per (thread, agent, task, kind), flush every ~30ms.
  private bufferDelta(
    rt: ThreadRuntime,
    agent: AgentName,
    taskId: string | undefined,
    ev: Extract<StreamEvent, { kind: "text_delta" | "thinking_delta" }>,
  ): void {
    const key = `${rt.id}|${agent}|${taskId ?? ""}|${ev.kind}`;
    const existing = this.deltaBuffers.get(key);
    if (existing) {
      existing.text += ev.text;
    } else {
      this.deltaBuffers.set(key, { agent, taskId, kind: ev.kind, text: ev.text });
    }
    this.deltaTimer ??= setTimeout(() => this.flushDeltas(), DELTA_COALESCE_MS);
  }

  private flushDeltas(): void {
    if (this.deltaTimer) {
      clearTimeout(this.deltaTimer);
      this.deltaTimer = null;
    }
    for (const [key, buf] of this.deltaBuffers) {
      const threadId = key.split("|")[0]!;
      this.broadcast({
        type: "event",
        threadId,
        seq: -1,
        agent: buf.agent,
        taskId: buf.taskId,
        ev: { kind: buf.kind, text: buf.text },
      });
    }
    this.deltaBuffers.clear();
  }

  // ---------------------------------------------------------------- misc

  private async emitStatus(rt: ThreadRuntime): Promise<void> {
    if (rt.deleted) return;
    this.broadcast({ type: "status", threadId: rt.id, status: rt.status, mode: rt.mode });
    const rec = await threadsDb.getThread(rt.id);
    if (rec) this.broadcast({ type: "thread_updated", thread: this.enrichMeta(rec) });
  }

  private async maybeAutoTitle(rt: ThreadRuntime): Promise<void> {
    if (rt.deleted || rt.title !== "New thread") return;
    const text = rt.lastAssistantText.trim();
    if (!text) return;
    const title = text.replace(/[#*`>\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
    if (!title) return;
    rt.title = title;
    const rec = await threadsDb.updateThread(rt.id, { title });
    if (rec) this.broadcast({ type: "thread_updated", thread: this.enrichMeta(rec) });
  }

  async shutdown(): Promise<void> {
    this.flushDeltas();
    for (const rt of this.runtimes.values()) {
      rt.pendingQuestion?.reject(new Error("server shutting down"));
      await rt.conductor?.session.abort().catch(() => {});
      rt.conductor?.session.dispose();
      await this.flushStaged(rt);
    }
    this.runtimes.clear();
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n… (truncated)` : text;
}

/**
 * Constant-time string comparison for trigger tokens. Falls back to a plain
 * inequality check when the lengths differ (still single-bit, but the length
 * itself is not secret for randomly generated tokens). Both inputs must be
 * non-empty — callers gate on that first.
 */
function timingSafeEqualString(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}
