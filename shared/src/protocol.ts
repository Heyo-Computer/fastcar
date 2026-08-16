/**
 * The wire contract between the fastcar server and web UI.
 * One WebSocket per browser tab; JSON messages tagged with `type`.
 * Events additionally flow through Postgres for history replay (REST).
 */

export type ThreadMode = "plan" | "act";
export type ThreadStatus = "idle" | "running" | "awaiting_input" | "awaiting_approval";
export type AgentName = "conductor" | "maxcoding" | "minimodel";

export interface ThreadMeta {
  id: string;
  title: string;
  mode: ThreadMode;
  status: ThreadStatus;
  archived: boolean;
  createdAt: string; // ISO
  updatedAt: string; // ISO
}

/** A pending interaction that must survive page refresh (stored in threads.pending_json). */
export type PendingInteraction =
  | { kind: "question"; questionId: string; prompt: string; options?: string[] }
  | { kind: "plan"; planMarkdown: string };

// ---------------------------------------------------------------------------
// Stream events (server → client, live; complete items also persisted to PG)
// ---------------------------------------------------------------------------

export type StreamEvent =
  | { kind: "user_message"; text: string }
  /** Output of a slash command — the app talking, not the model. */
  | { kind: "system"; text: string }
  | { kind: "message_start"; role: "assistant" }
  | { kind: "text_delta"; text: string }
  | { kind: "thinking_delta"; text: string }
  | { kind: "message_end"; text: string; thinking?: string; usage?: UsageSummary }
  | { kind: "tool_start"; toolCallId: string; name: string; args: unknown }
  | { kind: "tool_update"; toolCallId: string; output: string }
  | { kind: "tool_end"; toolCallId: string; ok: boolean; result: string }
  | { kind: "question"; questionId: string; prompt: string; options?: string[] }
  | { kind: "answer"; questionId: string; text: string }
  | { kind: "plan"; planMarkdown: string }
  | { kind: "error"; message: string };

export interface UsageSummary {
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cost?: number;
}

// ---------------------------------------------------------------------------
// Repositories
// ---------------------------------------------------------------------------

/** Live git state of a registered repository, for the UI repo panel. */
export interface RepoStatus {
  name: string;
  url: string;
  path: string;
  branch: string | null;
  dirty: boolean;
  ahead?: number;
  behind?: number;
  missing?: boolean;
  /** ISO date of the last commit — how the UI tells old repos from fresh ones. */
  lastCommitAt?: string;
}

/** Result of DELETE /api/repos/:name */
export interface PurgeRepoResponse {
  name: string;
  path: string;
  /** True when only the registry entry was dropped and no files were deleted. */
  registryOnly: boolean;
}

// ---------------------------------------------------------------------------
// Composer autocomplete: slash commands and @-mentions
// ---------------------------------------------------------------------------

/**
 * Where a slash command runs. Server commands are dispatched to the
 * ThreadManager; client commands (there are few) are handled in the browser
 * because they act on the UI rather than on a thread.
 */
export type CommandScope = "server" | "client";

/** One entry in the composer's `/` menu. */
export interface CommandSpec {
  /** Name without the leading slash, e.g. "compact". */
  name: string;
  /** One-line description shown in the menu. */
  summary: string;
  /** Argument placeholder shown after the name, e.g. "[instructions]". */
  argHint?: string;
  scope: CommandScope;
  /** Alternate names that resolve to this command (no leading slash). */
  aliases?: string[];
}

export type MentionKind = "agent" | "repo" | "dir" | "file";

/** One entry in the composer's `@` menu. */
export interface MentionItem {
  kind: MentionKind;
  /** Text inserted after the "@", e.g. "myrepo/src/index.ts". */
  value: string;
  /** Primary label shown in the menu. */
  label: string;
  /** Secondary text: absolute path, branch, agent description. */
  detail?: string;
}

// ---------------------------------------------------------------------------
// Client → Server
// ---------------------------------------------------------------------------

export type ClientMessage =
  | { type: "prompt"; threadId: string; text: string }
  /** Run a server-scoped slash command against a thread. */
  | { type: "command"; threadId: string; name: string; args?: string }
  | { type: "create_thread"; mode?: ThreadMode }
  | { type: "set_mode"; threadId: string; mode: ThreadMode }
  | { type: "answer_question"; threadId: string; questionId: string; answer: string }
  | { type: "approve_plan"; threadId: string }
  | { type: "reject_plan"; threadId: string; feedback: string }
  | { type: "abort"; threadId: string }
  | { type: "steer"; threadId: string; text: string }
  /** Ask the agent to clone a repository into the VM (routed through the conductor). */
  | { type: "add_repo"; url: string; name?: string; threadId?: string };

// ---------------------------------------------------------------------------
// Server → Client
// ---------------------------------------------------------------------------

export type ServerMessage =
  | { type: "hello"; threads: ThreadMeta[] }
  | { type: "thread_created"; thread: ThreadMeta }
  | { type: "thread_updated"; thread: ThreadMeta }
  | { type: "status"; threadId: string; status: ThreadStatus; mode: ThreadMode }
  | {
      type: "event";
      threadId: string;
      seq: number;
      agent: AgentName;
      taskId?: string;
      ev: StreamEvent;
    }
  | { type: "question"; threadId: string; questionId: string; prompt: string; options?: string[] }
  | { type: "plan_ready"; threadId: string; planMarkdown: string }
  | { type: "repos_updated"; repos: RepoStatus[] }
  | { type: "error"; threadId?: string; message: string };

// ---------------------------------------------------------------------------
// REST shapes
// ---------------------------------------------------------------------------

/** Row shape returned by GET /api/threads/:id/events */
export interface PersistedEvent {
  seq: number;
  agent: AgentName;
  taskId: string | null;
  kind:
    | "user_message"
    | "system"
    | "assistant_text"
    | "thinking"
    | "tool_call"
    | "plan"
    | "question"
    | "answer"
    | "error"
    | "usage";
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface ThreadHistoryResponse {
  thread: ThreadMeta;
  events: PersistedEvent[];
  pending: PendingInteraction | null;
}

export interface TranscribeResponse {
  text: string;
}

/** GET /api/commands */
export interface CommandsResponse {
  commands: CommandSpec[];
}

/** GET /api/mentions?q=…&limit=… */
export interface MentionsResponse {
  items: MentionItem[];
}
