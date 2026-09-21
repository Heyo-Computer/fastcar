import { create } from "zustand";
import type {
  AgentDef,
  AgentName,
  InboxItem,
  ModelsResponse,
  Schedule,
  ToolInfoRow,
  ArtifactNode,
  CommandSpec,
  PendingInteraction,
  PersistedEvent,
  PromptTemplate,
  McpServerStatus,
  RepoStatus,
  ServerMessage,
  StreamEvent,
  ThreadMeta,
  UsageSummary,
} from "@fastcar/shared";
import { fetchCommands } from "../lib/suggestions.ts";
import { navigate, parseHash, type Route } from "../lib/router.ts";

// ---------------------------------------------------------------- chat items

export interface SubActivity {
  agent: AgentName;
  taskId: string;
  /** Simplified activity lines + accumulated report text. */
  lines: string[];
  text: string;
  done: boolean;
}

export type ChatItem =
  | { type: "user"; key: string; text: string }
  /** Slash command output — the app talking, not the model. */
  | { type: "system"; key: string; text: string }
  | {
      type: "assistant";
      key: string;
      text: string;
      thinking: string;
      streaming: boolean;
      usage?: UsageSummary;
    }
  | {
      type: "tool";
      key: string;
      toolCallId: string;
      name: string;
      args: unknown;
      output: string;
      result: string;
      ok: boolean | null;
      done: boolean;
      subs: SubActivity[];
    }
  | {
      type: "question";
      key: string;
      questionId: string;
      prompt: string;
      options?: string[];
      answer?: string;
    }
  | { type: "plan"; key: string; planMarkdown: string; resolved?: "approved" | "rejected" }
  | { type: "error"; key: string; message: string };

interface ThreadChat {
  items: ChatItem[];
  loaded: boolean;
}

export interface AppState {
  connection: "connecting" | "open" | "closed";
  /** The current view. The hash is the source of truth; this mirrors it. */
  route: Route;
  threads: ThreadMeta[];
  /**
   * Derived from `route`, kept so the many components that ask "which thread
   * is open" do not each have to narrow the route union.
   */
  selectedId: string | null;
  agents: AgentDef[];
  inbox: InboxItem[];
  unreadByAgent: Record<string, number>;
  totalUnread: number;
  schedules: Schedule[];
  toolCatalog: ToolInfoRow[];
  modelCatalog: ModelsResponse["providers"];
  chats: Record<string, ThreadChat>;
  pending: Record<string, PendingInteraction | null>;
  /** Webhook delivery status for prompt threads (Feature 3). */
  promptStatus: Record<string, { status: string; response?: string }>;
  repos: RepoStatus[];
  mcpServers: McpServerStatus[];
  /** Slash commands the server offers, for the composer's `/` menu. */
  commands: CommandSpec[];
  /** Predefined prompt templates (Feature 3). */
  promptTemplates: PromptTemplate[];
  /** Artifact trees per thread (Feature 1). */
  artifactTrees: Record<string, ArtifactNode[]>;
  /** Thread the UI should auto-select when it is created by us. */
  awaitingCreatedThread: boolean;
  /** UI overlay state: which modal is open. */
  modal: "none" | "settings" | "newPrompt" | "addArtifact";
  /** Last slash_result ack (Feature 2). */
  lastSlashResult: { ok: boolean; message: string } | null;

  setConnection(c: AppState["connection"]): void;
  handleServer(msg: ServerMessage): void;
  setRoute(r: Route): void;
  selectThread(id: string | null): void;
  loadAgents(): Promise<void>;
  loadThreadsForAgent(agentId: string): Promise<void>;
  loadInbox(): Promise<void>;
  loadSchedules(): Promise<void>;
  loadToolCatalog(): Promise<void>;
  loadModelCatalog(): Promise<void>;
  markRead(threadId: string): Promise<void>;
  loadHistory(id: string): Promise<void>;
  loadRepos(): Promise<void>;
  loadMcpServers(): Promise<void>;
  loadCommands(): Promise<void>;
  loadPromptTemplates(): Promise<void>;
  loadArtifacts(threadId: string): Promise<void>;
  setModal(m: AppState["modal"]): void;
}

let keyCounter = 0;
const nextKey = () => `k${++keyCounter}`;

function emptyChat(): ThreadChat {
  return { items: [], loaded: false };
}

// ---------------------------------------------------------------- reducers

function lastAssistant(items: ChatItem[]): Extract<ChatItem, { type: "assistant" }> | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item?.type === "assistant") return item;
    if (item?.type === "user") return undefined;
  }
  return undefined;
}

function findTool(items: ChatItem[], toolCallId: string) {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item?.type === "tool" && item.toolCallId === toolCallId) return item;
  }
  return undefined;
}

/** taskId is `${parentToolCallId}:${index}` — find the owning run_subagent tool card. */
function findSub(items: ChatItem[], agent: AgentName, taskId: string): SubActivity | undefined {
  const parentId = taskId.split(":")[0]!;
  const tool = findTool(items, parentId);
  if (!tool) return undefined;
  let sub = tool.subs.find((s) => s.taskId === taskId);
  if (!sub) {
    sub = { agent, taskId, lines: [], text: "", done: false };
    tool.subs.push(sub);
  }
  return sub;
}

export function applyStreamEvent(
  items: ChatItem[],
  agent: AgentName,
  taskId: string | undefined,
  ev: StreamEvent,
): void {
  // `taskId` alone is the discriminator: it is set only for subagent events
  // (ThreadManager.onSubagentEvent), and findSub needs it regardless to locate
  // the owning run_subagent card via `taskId.split(":")[0]`. The previous
  // `agent !== "conductor" && taskId` was equivalent — no event is ever both
  // conductor-authored and task-scoped — but it implied the agent name carries
  // meaning here, which it does not, and which stops being true at a glance
  // once the top-level agent is user-defined rather than literally "conductor".
  if (taskId) {
    const sub = findSub(items, agent, taskId);
    if (!sub) return;
    switch (ev.kind) {
      case "text_delta":
        sub.text += ev.text;
        break;
      case "message_end":
        if (ev.text) sub.text = ev.text;
        sub.done = true;
        break;
      case "tool_start":
        sub.lines.push(`→ ${ev.name} ${compactArgs(ev.args)}`);
        break;
      case "tool_end":
        sub.lines.push(`← ${ev.ok ? "ok" : "error"}`);
        break;
      default:
        break;
    }
    return;
  }

  switch (ev.kind) {
    case "user_message":
      items.push({ type: "user", key: nextKey(), text: ev.text });
      break;
    case "system":
      items.push({ type: "system", key: nextKey(), text: ev.text });
      break;
    case "message_start":
      items.push({ type: "assistant", key: nextKey(), text: "", thinking: "", streaming: true });
      break;
    case "text_delta": {
      let a = lastAssistant(items);
      if (!a || !a.streaming) {
        a = { type: "assistant", key: nextKey(), text: "", thinking: "", streaming: true };
        items.push(a);
      }
      a.text += ev.text;
      break;
    }
    case "thinking_delta": {
      let a = lastAssistant(items);
      if (!a || !a.streaming) {
        a = { type: "assistant", key: nextKey(), text: "", thinking: "", streaming: true };
        items.push(a);
      }
      a.thinking += ev.text;
      break;
    }
    case "message_end": {
      const a = lastAssistant(items);
      if (a && a.streaming) {
        a.text = ev.text || a.text;
        a.thinking = ev.thinking ?? a.thinking;
        a.streaming = false;
        a.usage = ev.usage;
      } else if (ev.text) {
        items.push({
          type: "assistant",
          key: nextKey(),
          text: ev.text,
          thinking: ev.thinking ?? "",
          streaming: false,
          usage: ev.usage,
        });
      }
      break;
    }
    case "tool_start":
      items.push({
        type: "tool",
        key: nextKey(),
        toolCallId: ev.toolCallId,
        name: ev.name,
        args: ev.args,
        output: "",
        result: "",
        ok: null,
        done: false,
        subs: [],
      });
      break;
    case "tool_update": {
      const t = findTool(items, ev.toolCallId);
      if (t) t.output = ev.output;
      break;
    }
    case "tool_end": {
      const t = findTool(items, ev.toolCallId);
      if (t) {
        t.done = true;
        t.ok = ev.ok;
        t.result = ev.result;
        for (const sub of t.subs) sub.done = true;
      }
      break;
    }
    case "question":
      items.push({
        type: "question",
        key: nextKey(),
        questionId: ev.questionId,
        prompt: ev.prompt,
        options: ev.options,
      });
      break;
    case "answer": {
      for (let i = items.length - 1; i >= 0; i--) {
        const item = items[i];
        if (item?.type === "question" && item.questionId === ev.questionId) {
          item.answer = ev.text;
          break;
        }
      }
      break;
    }
    case "plan":
      items.push({ type: "plan", key: nextKey(), planMarkdown: ev.planMarkdown });
      break;
    case "error":
      items.push({ type: "error", key: nextKey(), message: ev.message });
      break;
  }
}

export function applyPersistedEvent(items: ChatItem[], row: PersistedEvent): void {
  const { agent, kind, payload } = row;
  const taskId = row.taskId ?? undefined;

  if (taskId) {
    // Subagent history rows nest under their tool card. Same discriminator as
    // applyStreamEvent above — these two reducers must stay in step.
    if (kind === "assistant_text") {
      const sub = findSub(items, agent, taskId);
      if (sub) {
        sub.text = String(payload.text ?? "");
        sub.done = true;
      }
    } else if (kind === "tool_call") {
      const sub = findSub(items, agent, taskId);
      if (sub) {
        if (payload.phase === "start") sub.lines.push(`→ ${String(payload.name)} ${compactArgs(payload.args)}`);
        else sub.lines.push(`← ${payload.ok ? "ok" : "error"}`);
      }
    }
    return;
  }

  switch (kind) {
    case "user_message":
      items.push({ type: "user", key: nextKey(), text: String(payload.text ?? "") });
      break;
    case "system":
      items.push({ type: "system", key: nextKey(), text: String(payload.text ?? "") });
      break;
    case "assistant_text":
      items.push({
        type: "assistant",
        key: nextKey(),
        text: String(payload.text ?? ""),
        thinking: String(payload.thinking ?? ""),
        streaming: false,
        usage: payload.usage as UsageSummary | undefined,
      });
      break;
    case "tool_call": {
      if (payload.phase === "start") {
        items.push({
          type: "tool",
          key: nextKey(),
          toolCallId: String(payload.toolCallId ?? ""),
          name: String(payload.name ?? "tool"),
          args: payload.args,
          output: "",
          result: "",
          ok: null,
          done: false,
          subs: [],
        });
      } else {
        const t = findTool(items, String(payload.toolCallId ?? ""));
        if (t) {
          t.done = true;
          t.ok = Boolean(payload.ok);
          t.result = String(payload.result ?? "");
        }
      }
      break;
    }
    case "question":
      items.push({
        type: "question",
        key: nextKey(),
        questionId: String(payload.questionId ?? ""),
        prompt: String(payload.prompt ?? ""),
        options: payload.options as string[] | undefined,
      });
      break;
    case "answer": {
      for (let i = items.length - 1; i >= 0; i--) {
        const item = items[i];
        if (item?.type === "question" && item.questionId === payload.questionId) {
          item.answer = String(payload.text ?? "");
          break;
        }
      }
      break;
    }
    case "plan":
      items.push({ type: "plan", key: nextKey(), planMarkdown: String(payload.planMarkdown ?? "") });
      break;
    case "error":
      items.push({ type: "error", key: nextKey(), message: String(payload.message ?? "") });
      break;
    default:
      break;
  }
}

function compactArgs(args: unknown): string {
  try {
    const s = JSON.stringify(args);
    return s.length > 80 ? `${s.slice(0, 80)}…` : s;
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------- store

export const useStore = create<AppState>((set, get) => ({
  connection: "connecting",
  route: parseHash(),
  threads: [],
  selectedId: parseHash().name === "thread" ? (parseHash() as { threadId: string }).threadId : null,
  agents: [],
  inbox: [],
  unreadByAgent: {},
  totalUnread: 0,
  schedules: [],
  toolCatalog: [],
  modelCatalog: [],
  chats: {},
  pending: {},
  promptStatus: {},
  repos: [],
  mcpServers: [],
  commands: [],
  promptTemplates: [],
  artifactTrees: {},
  awaitingCreatedThread: false,
  modal: "none",
  lastSlashResult: null,

  setConnection: (connection) => set({ connection }),

  setModal: (modal) => set({ modal }),

  handleServer: (msg) => {
    const state = get();
    switch (msg.type) {
      case "hello":
        set({ threads: msg.threads });
        void get().loadRepos();
        void get().loadMcpServers();
        void get().loadAgents();
        void get().loadInbox();
        void get().loadSchedules();
        break;
      case "repos_updated":
        set({ repos: msg.repos });
        break;
      case "mcp_servers_updated":
        set({ mcpServers: msg.servers });
        break;
      case "agents_updated":
        set({ agents: msg.agents });
        break;
      case "schedules_updated":
        set({ schedules: msg.schedules });
        break;
      case "inbox_counts":
        set({ unreadByAgent: msg.unreadByAgent, totalUnread: msg.totalUnread });
        break;
      case "artifacts_updated":
        void get().loadArtifacts(msg.threadId);
        break;
      case "thread_created": {
        const threads = [msg.thread, ...state.threads.filter((t) => t.id !== msg.thread.id)];
        const patch: Partial<AppState> = { threads };
        if (state.awaitingCreatedThread) {
          patch.awaitingCreatedThread = false;
          patch.chats = { ...state.chats, [msg.thread.id]: { items: [], loaded: true } };
          // Navigating sets selectedId via setRoute, so the URL and the open
          // thread cannot disagree.
          navigate({ name: "thread", threadId: msg.thread.id });
        } else if (state.route.name === "inbox" || state.route.name === "agent") {
          // A thread appearing while the inbox is open (a schedule firing, say)
          // should show up without a refresh.
          void get().loadInbox();
        }
        set(patch);
        break;
      }
      case "thread_deleted": {
        const threads = state.threads.filter((t) => t.id !== msg.threadId);
        const chats = { ...state.chats };
        const pending = { ...state.pending };
        const promptStatus = { ...state.promptStatus };
        const artifactTrees = { ...state.artifactTrees };
        delete chats[msg.threadId];
        delete pending[msg.threadId];
        delete promptStatus[msg.threadId];
        delete artifactTrees[msg.threadId];
        const inbox = state.inbox.filter((i) => i.threadId !== msg.threadId);
        set({ threads, chats, pending, promptStatus, artifactTrees, inbox });
        // Deleting the thread you are looking at returns you to the inbox
        // rather than silently swapping in someone else's thread.
        if (state.selectedId === msg.threadId) navigate({ name: "inbox", filter: "all" });
        break;
      }
      case "thread_updated": {
        const threads = state.threads.map((t) => (t.id === msg.thread.id ? msg.thread : t));
        if (!threads.some((t) => t.id === msg.thread.id)) threads.unshift(msg.thread);
        threads.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
        // Keep the open inbox list in step without refetching: the broadcast
        // already carries everything a row shows except the preview text.
        const inbox = state.inbox.map((i) =>
          i.threadId === msg.thread.id
            ? {
                ...i,
                title: msg.thread.title,
                status: msg.thread.status,
                mode: msg.thread.mode,
                unread: msg.thread.unread ?? i.unread,
                needsYou:
                  msg.thread.status === "awaiting_input" ||
                  msg.thread.status === "awaiting_approval",
                preview: msg.thread.lastMessagePreview ?? i.preview,
                lastMessageAt: msg.thread.lastMessageAt ?? i.lastMessageAt,
              }
            : i,
        );
        set({ threads, inbox });
        break;
      }
      case "status": {
        const threads = state.threads.map((t) =>
          t.id === msg.threadId ? { ...t, status: msg.status, mode: msg.mode } : t,
        );
        const pending = { ...state.pending };
        if (msg.status === "idle" || msg.status === "running") pending[msg.threadId] = null;
        set({ threads, pending });
        break;
      }
      case "event": {
        const chat = state.chats[msg.threadId] ?? emptyChat();
        const items = [...chat.items];
        applyStreamEvent(items, msg.agent, msg.taskId, msg.ev);
        set({ chats: { ...state.chats, [msg.threadId]: { ...chat, items } } });
        break;
      }
      case "question":
        set({
          pending: {
            ...state.pending,
            [msg.threadId]: {
              kind: "question",
              questionId: msg.questionId,
              prompt: msg.prompt,
              options: msg.options,
            },
          },
        });
        break;
      case "plan_ready":
        set({
          pending: {
            ...state.pending,
            [msg.threadId]: { kind: "plan", planMarkdown: msg.planMarkdown },
          },
        });
        break;
      case "prompt_thread_result":
        set({
          promptStatus: {
            ...state.promptStatus,
            [msg.threadId]: { status: msg.status, response: msg.response },
          },
        });
        break;
      case "slash_result":
        set({ lastSlashResult: { ok: msg.ok, message: msg.message } });
        break;
      case "error": {
        if (msg.threadId) {
          const chat = state.chats[msg.threadId] ?? emptyChat();
          const items = [...chat.items, { type: "error" as const, key: nextKey(), message: msg.message }];
          set({ chats: { ...state.chats, [msg.threadId]: { ...chat, items } } });
        } else {
          console.error("server error:", msg.message);
        }
        break;
      }
    }
  },

  /**
   * Called by the hashchange listener in main.tsx. `selectedId` is derived
   * here so there is exactly one place that reads the route union, and the
   * lazy loads a thread needs happen whether you clicked a link, hit back, or
   * pasted a URL.
   */
  setRoute: (route) => {
    const selectedId = route.name === "thread" ? route.threadId : null;
    set({ route, selectedId });
    if (selectedId) {
      if (!get().chats[selectedId]?.loaded) void get().loadHistory(selectedId);
      if (!get().artifactTrees[selectedId]) void get().loadArtifacts(selectedId);
      // Opening a thread is what marks it read; the broadcast keeps other tabs
      // and the sidebar counts in step.
      void get().markRead(selectedId);
    }
    if (route.name === "inbox") void get().loadInbox();
    if (route.name === "schedules") void get().loadSchedules();
    if (route.name === "agentNew" || route.name === "agentEdit") {
      void get().loadToolCatalog();
      void get().loadModelCatalog();
    }
  },

  /** Navigating is the only way to open a thread — the URL leads. */
  selectThread: (id) => {
    if (id) navigate({ name: "thread", threadId: id });
    else navigate({ name: "inbox", filter: "all" });
  },

  loadAgents: async () => {
    const res = await fetch("/api/agents");
    if (!res.ok) return;
    const data = (await res.json()) as { agents: AgentDef[] };
    set({ agents: data.agents });
  },

  /**
   * Threads owned by one agent. `hello` only carries a recent window, so a
   * quiet agent's threads have to be fetched when you open it.
   */
  loadThreadsForAgent: async (agentId) => {
    const res = await fetch(`/api/threads?agentId=${agentId}&limit=200`);
    if (!res.ok) return;
    const data = (await res.json()) as { threads: ThreadMeta[] };
    set((state) => {
      const byId = new Map(state.threads.map((t) => [t.id, t]));
      for (const t of data.threads) byId.set(t.id, t);
      const threads = [...byId.values()].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
      return { threads };
    });
  },

  loadInbox: async () => {
    const r = get().route;
    const params = new URLSearchParams();
    if (r.name === "inbox" && r.filter !== "all") params.set("filter", r.filter);
    if (r.name === "agent") params.set("agentId", r.agentId);
    const res = await fetch(`/api/inbox?${params}`);
    if (!res.ok) return;
    const data = (await res.json()) as {
      items: InboxItem[];
      unreadByAgent: Record<string, number>;
      totalUnread: number;
    };
    set({ inbox: data.items, unreadByAgent: data.unreadByAgent, totalUnread: data.totalUnread });
  },

  loadSchedules: async () => {
    const res = await fetch("/api/schedules");
    if (!res.ok) return;
    const data = (await res.json()) as { schedules: Schedule[] };
    set({ schedules: data.schedules });
  },

  loadToolCatalog: async () => {
    if (get().toolCatalog.length) return;
    const res = await fetch("/api/tools");
    if (!res.ok) return;
    const data = (await res.json()) as { tools: ToolInfoRow[] };
    set({ toolCatalog: data.tools });
  },

  loadModelCatalog: async () => {
    if (get().modelCatalog.length) return;
    const res = await fetch("/api/models");
    if (!res.ok) return;
    const data = (await res.json()) as ModelsResponse;
    set({ modelCatalog: data.providers });
  },

  markRead: async (threadId) => {
    await fetch(`/api/inbox/${threadId}/read`, { method: "POST" }).catch(() => {});
  },

  loadRepos: async () => {
    const res = await fetch("/api/repos");
    if (!res.ok) return;
    const data = (await res.json()) as { repos: RepoStatus[] };
    set({ repos: data.repos });
  },

  loadMcpServers: async () => {
    const res = await fetch("/api/mcp");
    if (!res.ok) return;
    const data = (await res.json()) as { servers: McpServerStatus[] };
    set({ mcpServers: data.servers });
  },

  loadCommands: async () => {
    set({ commands: await fetchCommands() });
  },

  loadPromptTemplates: async () => {
    const res = await fetch("/api/prompt-templates");
    if (!res.ok) return;
    const data = (await res.json()) as { templates: PromptTemplate[] };
    set({ promptTemplates: data.templates });
  },

  loadArtifacts: async (threadId) => {
    const res = await fetch(`/api/threads/${threadId}/artifacts`);
    if (!res.ok) return;
    const data = (await res.json()) as { artifacts: ArtifactNode[] };
    set({ artifactTrees: { ...get().artifactTrees, [threadId]: data.artifacts } });
  },

  loadHistory: async (id) => {
    const res = await fetch(`/api/threads/${id}/events`);
    if (!res.ok) return;
    const data = (await res.json()) as {
      thread: ThreadMeta;
      events: PersistedEvent[];
      pending: PendingInteraction | null;
    };
    const items: ChatItem[] = [];
    for (const row of data.events) applyPersistedEvent(items, row);
    set((state) => {
      // The history response carries the thread meta, which is how a deep link
      // to a thread outside the `hello` window still renders.
      const threads = state.threads.some((t) => t.id === id)
        ? state.threads
        : [data.thread, ...state.threads].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
      return {
        threads,
        chats: { ...state.chats, [id]: { items, loaded: true } },
        pending: { ...state.pending, [id]: data.pending },
      };
    });
  },
}));
