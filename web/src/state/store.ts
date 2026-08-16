import { create } from "zustand";
import type {
  AgentName,
  CommandSpec,
  PendingInteraction,
  PersistedEvent,
  RepoStatus,
  ServerMessage,
  StreamEvent,
  ThreadMeta,
  UsageSummary,
} from "@fastcar/shared";
import { fetchCommands } from "../lib/suggestions.ts";

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
  threads: ThreadMeta[];
  selectedId: string | null;
  chats: Record<string, ThreadChat>;
  pending: Record<string, PendingInteraction | null>;
  repos: RepoStatus[];
  /** Slash commands the server offers, for the composer's `/` menu. */
  commands: CommandSpec[];
  /** Thread the UI should auto-select when it is created by us. */
  awaitingCreatedThread: boolean;

  setConnection(c: AppState["connection"]): void;
  handleServer(msg: ServerMessage): void;
  selectThread(id: string | null): void;
  loadHistory(id: string): Promise<void>;
  loadRepos(): Promise<void>;
  loadCommands(): Promise<void>;
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

function applyStreamEvent(
  items: ChatItem[],
  agent: AgentName,
  taskId: string | undefined,
  ev: StreamEvent,
): void {
  if (agent !== "conductor" && taskId) {
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

function applyPersistedEvent(items: ChatItem[], row: PersistedEvent): void {
  const { agent, kind, payload } = row;
  const taskId = row.taskId ?? undefined;

  if (agent !== "conductor" && taskId) {
    // Subagent history rows nest under their tool card.
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
  threads: [],
  selectedId: null,
  chats: {},
  pending: {},
  repos: [],
  commands: [],
  awaitingCreatedThread: false,

  setConnection: (connection) => set({ connection }),

  handleServer: (msg) => {
    const state = get();
    switch (msg.type) {
      case "hello":
        set({ threads: msg.threads });
        void get().loadRepos();
        break;
      case "repos_updated":
        set({ repos: msg.repos });
        break;
      case "thread_created": {
        const threads = [msg.thread, ...state.threads.filter((t) => t.id !== msg.thread.id)];
        const patch: Partial<AppState> = { threads };
        if (state.awaitingCreatedThread) {
          patch.selectedId = msg.thread.id;
          patch.awaitingCreatedThread = false;
          patch.chats = { ...state.chats, [msg.thread.id]: { items: [], loaded: true } };
        }
        set(patch);
        break;
      }
      case "thread_updated": {
        const threads = state.threads.map((t) => (t.id === msg.thread.id ? msg.thread : t));
        if (!threads.some((t) => t.id === msg.thread.id)) threads.unshift(msg.thread);
        threads.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
        set({ threads });
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

  selectThread: (id) => {
    set({ selectedId: id });
    if (id && !get().chats[id]?.loaded) void get().loadHistory(id);
  },

  loadRepos: async () => {
    const res = await fetch("/api/repos");
    if (!res.ok) return;
    const data = (await res.json()) as { repos: RepoStatus[] };
    set({ repos: data.repos });
  },

  loadCommands: async () => {
    set({ commands: await fetchCommands() });
  },

  loadHistory: async (id) => {
    const res = await fetch(`/api/threads/${id}/events`);
    if (!res.ok) return;
    const data = (await res.json()) as {
      events: PersistedEvent[];
      pending: PendingInteraction | null;
    };
    const items: ChatItem[] = [];
    for (const row of data.events) applyPersistedEvent(items, row);
    set((state) => ({
      chats: { ...state.chats, [id]: { items, loaded: true } },
      pending: { ...state.pending, [id]: data.pending },
    }));
  },
}));
