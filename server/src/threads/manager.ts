import type {
  AgentName,
  PendingInteraction,
  ServerMessage,
  StreamEvent,
  ThreadMeta,
  ThreadMode,
  ThreadStatus,
} from "@fastcar/shared";
import type { Config } from "../config.js";
import { insertEvents, maxSeq, type EventInsert } from "../db/events.js";
import * as threadsDb from "../db/threads.js";
import { toMeta } from "../db/threads.js";
import { createConductorSession, type ConductorHandle } from "../pi/conductor.js";
import { collectRepoStatuses, gitEvents } from "../services/git.js";
import { translateSessionEvent } from "../pi/events.js";
import type { FastcarModels } from "../pi/runtime.js";
import type { SubagentKind, SubagentManager } from "../pi/subagents.js";

type Broadcast = (msg: ServerMessage) => void;

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
  pendingQuestion: PendingQuestion | null;
  submittedPlan: string | null;
  /** Rolling text of the current assistant message, for title + plan fallback. */
  lastAssistantText: string;
  creating: Promise<ConductorHandle> | null;
}

const DELTA_COALESCE_MS = 30;

export class ThreadManager {
  private runtimes = new Map<string, ThreadRuntime>();
  private clients = new Set<Broadcast>();
  private deltaBuffers = new Map<string, { agent: AgentName; taskId?: string; kind: "text_delta" | "thinking_delta"; text: string }>();
  private deltaTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly cfg: Config,
    private readonly models: FastcarModels,
    private readonly subagents: SubagentManager,
  ) {
    gitEvents.on("changed", () => void this.broadcastRepos());
  }

  async broadcastRepos(): Promise<void> {
    try {
      const repos = await collectRepoStatuses();
      this.broadcast({ type: "repos_updated", repos });
    } catch (err) {
      console.error("failed to collect repo statuses:", err);
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

  async createThread(mode: ThreadMode = "act"): Promise<ThreadMeta> {
    const rec = await threadsDb.createThread(mode);
    const meta = toMeta(rec);
    this.broadcast({ type: "thread_created", thread: meta });
    return meta;
  }

  async setMode(threadId: string, mode: ThreadMode): Promise<void> {
    const rt = await this.getRuntime(threadId);
    if (rt.status !== "idle") throw new Error("cannot change mode while the agent is busy");
    rt.mode = mode;
    await threadsDb.updateThread(threadId, { mode });
    await rt.conductor?.refreshSystemPrompt();
    await this.emitStatus(rt);
  }

  // ---------------------------------------------------------------- prompt

  async prompt(threadId: string, text: string): Promise<void> {
    const rt = await this.getRuntime(threadId);
    if (rt.status === "running") throw new Error("agent is already running — use steer");
    if (rt.status === "awaiting_input") throw new Error("answer the pending question first");
    if (rt.status === "awaiting_approval")
      throw new Error("approve or reject the pending plan first");

    // Handle slash commands locally before delegating to the conductor.
    if (text.startsWith("/")) {
      const parts = text.trim().split(/\s+/);
      const cmd = parts[0].toLowerCase();
      const args = parts.slice(1);
      switch (cmd) {
        case "/compaction": {
          // Placeholder: in a real implementation this would trigger repo compaction.
          const msg = "✅ Compaction command received – no operation performed in this demo.";
          this.stageAndSend(rt, "conductor", undefined, { kind: "message_end", text: msg });
          await this.flushStaged(rt);
          return;
        }
        case "/context": {
          // Return current repository statuses as a message.
          const repos = await collectRepoStatuses();
          const repoList = repos.map(r => `${r.name} (${r.branch ?? "?"})`).join("\n");
          const msg = `🗂️ Current repositories:\n${repoList}`;
          this.stageAndSend(rt, "conductor", undefined, { kind: "message_end", text: msg });
          await this.flushStaged(rt);
          return;
        }
        default:
          // Unknown command – inform the user.
          const msg = `❓ Unknown command: ${cmd}`;
          this.stageAndSend(rt, "conductor", undefined, { kind: "message_end", text: msg });
          await this.flushStaged(rt);
          return;
      }
    }

    const conductor = await this.ensureConductor(rt);
    rt.status = "running";
    await threadsDb.updateThread(threadId, { status: "running" });
    await this.emitStatus(rt);

    this.stageAndSend(rt, "conductor", undefined, { kind: "user_message", text });
    // user_message rows are not tied to agent_end; flush immediately so a
    // crash mid-run still keeps the user's prompt in history.
    await this.flushStaged(rt);

    void this.runPrompt(rt, conductor, text);
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
    const rt = this.runtimes.get(threadId);
    if (!rt?.conductor || rt.status !== "running") throw new Error("agent is not running");
    this.stageAndSend(rt, "conductor", undefined, { kind: "user_message", text: `(steer) ${text}` });
    await rt.conductor.session.steer(text);
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

  private async getRuntime(threadId: string): Promise<ThreadRuntime> {
    let rt = this.runtimes.get(threadId);
    if (rt) return rt;
    const rec = await threadsDb.getThread(threadId);
    if (!rec) throw new Error(`no such thread: ${threadId}`);
    rt = {
      id: threadId,
      mode: rec.mode,
      status: rec.status,
      title: rec.title,
      conductor: null,
      seq: await maxSeq(threadId),
      staged: [],
      pendingQuestion: null,
      submittedPlan: null,
      lastAssistantText: "",
      creating: null,
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
        sessionFile: rec?.piSessionFile ?? null,
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
    if (!rt.staged.length) return;
    const batch = rt.staged;
    rt.staged = [];
    try {
      await insertEvents(batch);
    } catch (err) {
      console.error(`failed to persist events for thread ${rt.id}:`, err);
    }
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
    this.broadcast({ type: "status", threadId: rt.id, status: rt.status, mode: rt.mode });
    const rec = await threadsDb.getThread(rt.id);
    if (rec) this.broadcast({ type: "thread_updated", thread: toMeta(rec) });
  }

  private async maybeAutoTitle(rt: ThreadRuntime): Promise<void> {
    if (rt.title !== "New thread") return;
    const text = rt.lastAssistantText.trim();
    if (!text) return;
    const title = text.replace(/[#*`>\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
    if (!title) return;
    rt.title = title;
    const rec = await threadsDb.updateThread(rt.id, { title });
    if (rec) this.broadcast({ type: "thread_updated", thread: toMeta(rec) });
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
