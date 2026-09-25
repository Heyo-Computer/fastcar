/**
 * The wire contract between the fastcar server and web UI.
 * One WebSocket per browser tab; JSON messages tagged with `type`.
 * Events additionally flow through Postgres for history replay (REST).
 */

export type ThreadMode = "plan" | "act";
export type ThreadStatus = "idle" | "running" | "awaiting_input" | "awaiting_approval";
/**
 * The built-in delegation pools (agents.yaml). Not user-creatable: they own no
 * threads, no inbox rows and no schedules — they only run inside a parent
 * agent's `run_subagent` call.
 */
export type SubagentName = "maxcoding" | "minimodel";

/**
 * Who produced an event: a top-level agent's slug, or a SubagentName. This is
 * the `events.agent` column value, which is plain `text` with no CHECK, so
 * user-created agent slugs need no migration.
 *
 * Deliberately `string` rather than a union — agents are rows in Postgres, so
 * the set is not knowable at compile time. Nothing keys a Record off this type
 * and nothing switches exhaustively on it; the UI decides whether an event
 * nests under a subagent card from `taskId`, never from this field.
 */
export type AgentName = string;

/** Slug of the seeded built-in agent that owns every pre-existing thread. */
export const BUILTIN_AGENT_SLUG = "conductor";

/**
 * The kind of thread. "chat" is the normal interactive thread; "prompt" runs
 * a predefined prompt template through the LLM on creation and POSTs the
 * result to a webhook. The field is named `threadType` (not `type`) so it
 * never collides with the `type` discriminant on the surrounding message
 * unions — `ThreadMeta` is a plain interface, but the naming stays consistent
 * across the wire.
 */
export type ThreadType = "chat" | "prompt";

/**
 * How a thread was started. Separate from ThreadType, which is CHECK-constrained
 * in the database and asserted in the prompt-thread tests — a scheduled run is
 * an ordinary chat thread with source "schedule".
 */
export type ThreadSource = "chat" | "prompt" | "schedule" | "trigger";

export interface ThreadMeta {
  id: string;
  title: string;
  mode: ThreadMode;
  status: ThreadStatus;
  archived: boolean;
  threadType: ThreadType;
  /** Owning agent; null on threads that predate agents (they render as the builtin). */
  agentId?: string | null;
  /** How the thread started: typed by a user, a prompt template, cron, or a public trigger. */
  source?: ThreadSource;
  /** The schedule whose firing created this thread, when there was one. */
  scheduleId?: string | null;
  /** Inbox projection: the latest reply and whether it has been read. */
  lastMessageAt?: string | null;
  lastMessagePreview?: string | null;
  /** Derived, never stored — see db/threads.ts isUnread(). */
  unread?: boolean;
  /** Dismissed from the inbox with no reply since; the thread itself is untouched. */
  inboxHidden?: boolean;
  /** Public, unauthenticated trigger URL for a prompt thread (`/pt/<id>`), or null for chat threads. */
  publicUrl?: string | null;
  createdAt: string; // ISO
  updatedAt: string; // ISO
}

/** Configuration carried by a prompt thread (Feature 3). */
export interface PromptThreadConfig {
  templateId: string;
  webhookUrl: string;
  /** Bearer token is stored encrypted server-side; never sent to the client. */
  webhookTokenSet: boolean;
  /** Webhook delivery status, set after creation runs the prompt. */
  webhookStatus: "pending" | "success" | "error" | "skipped";
  webhookResponse?: string;
  /** Variables substituted into the template; stored so a trigger can re-resolve. */
  variables?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Artifacts (Feature 1): user-created nested files under a thread
// ---------------------------------------------------------------------------

export interface Artifact {
  /** Public (unauthenticated) URL where the artifact is served: /artifacts/<id>/<name>. */
  publicUrl: string;
  id: string;
  threadId: string;
  /** UUID of the parent artifact, or null at the root of the thread's tree. */
  parentArtifactId: string | null;
  name: string;
  /** MIME / content type, e.g. "text/markdown", "application/octet-stream". */
  contentType: string;
  /** Size of the stored content in bytes. */
  size: number;
  /** Owning user id, or null when auth is disabled (single-user dev mode). */
  ownerId: string | null;
  createdAt: string; // ISO
  updatedAt: string; // ISO
}

/** A node in the artifact tree returned by GET /api/threads/:id/artifacts. */
export interface ArtifactNode extends Artifact {
  children: ArtifactNode[];
}

/** GET /api/threads/:id/artifacts */
export interface ArtifactsTreeResponse {
  artifacts: ArtifactNode[];
}

/** GET /api/artifacts/:id */
export interface ArtifactResponse extends Artifact {
  /** Inline text content (text/* only); absent for binary artifacts. */
  content?: string;
  /** Relative path under data/artifacts/ where the bytes live. */
  storagePath: string;
}

/** POST /api/threads/:id/artifacts (multipart or JSON). */
export interface CreateArtifactResponse {
  artifact: Artifact;
}

/** GET /api/prompt-templates */
export interface PromptTemplatesResponse {
  templates: PromptTemplate[];
}

export interface PromptTemplate {
  id: string;
  description: string;
  promptText: string;
  /** Variable names the promptText substitutes with {{name}}. */
  variables?: string[];
}

/** GET /api/smtp — the password is never returned. */
export interface SmtpSettingsResponse {
  host: string;
  port: number;
  username: string;
  fromAddress: string;
  secure: boolean;
  configured: boolean;
}

/** POST /api/smtp — password is optional (blank keeps the stored value). */
export interface SmtpSettingsRequest {
  host: string;
  port: number;
  username: string;
  password?: string;
  fromAddress: string;
  secure: boolean;
}

/**
 * Conductor reasoning effort (InceptionLabs Mercury `reasoning_effort`):
 * instant = lowest latency, medium = default balance, high = harder planning
 * and coding. Stored server-side; applies to every conductor turn from the
 * next one on.
 */
export type ReasoningEffort = "instant" | "medium" | "high";
export const REASONING_EFFORTS: readonly ReasoningEffort[] = ["instant", "medium", "high"];

/** GET /api/settings */
export interface AppSettingsResponse {
  /** Read-only server facts the UI needs to warn about misconfiguration. */
  server: {
    /** The origin every public link is built from (FASTCAR_PUBLIC_URL). */
    publicUrl: string;
    /**
     * False when publicUrl is the localhost fallback because
     * FASTCAR_PUBLIC_URL was not set. The UI compares publicUrl against the
     * origin it was actually loaded from to catch a deployment that forgot it.
     */
    publicUrlFromEnv: boolean;
  };
  conductor: {
    /** Provider/model id the conductor runs on, e.g. inceptionlabs/mercury-2.5. */
    model: string;
    reasoningEffort: ReasoningEffort;
    /** Effort baked in by env (CONDUCTOR_REASONING_EFFORT) — what "reset" would restore. */
    defaultReasoningEffort: ReasoningEffort;
    /** max_tokens sent per request — the budget shared by reasoning and the answer. */
    maxTokens: number;
  };
}

/** POST /api/settings — partial; omitted fields keep their stored value. */
export interface AppSettingsRequest {
  conductor?: {
    reasoningEffort?: ReasoningEffort;
  };
}

// ---------------------------------------------------------------------------
// Subagent models (Feature: configurable subagent models + OMLX provider)
// ---------------------------------------------------------------------------

/**
 * Which inference provider the subagents (maxcoding / minimodel) run on.
 * `openrouter` is the Pi built-in OpenAI-compatible aggregator; `omlx` is a
 * self-hosted OpenAI-compatible endpoint (default http://localhost:8080/v1).
 * Defaults to `openrouter` when nothing is configured.
 */
export type SubagentProvider = "openrouter" | "omlx";
export const SUBAGENT_PROVIDERS: readonly SubagentProvider[] = ["openrouter", "omlx"];

/** One subagent's configurable model slug, or null to use the env default. */
export interface SubagentModelEntry {
  /** The model slug as the provider knows it, e.g. "anthropic/claude-sonnet-4.5". */
  model: string | null;
}

/** GET /api/subagent-models — current subagent model configuration. */
export interface SubagentSettingsResponse {
  /** Active provider for both subagents. */
  provider: SubagentProvider;
  /** OMLX base URL (only meaningful when provider is "omlx"). */
  omlxBaseUrl: string;
  /** Per-kind model overrides; null model means fall back to the env default. */
  maxcoding: SubagentModelEntry;
  minimodel: SubagentModelEntry;
  /** The env-baked defaults the UI could "reset" to. */
  defaults: {
    provider: SubagentProvider;
    maxcodingModel: string;
    minimodelModel: string;
    omlxBaseUrl: string;
  };
}

/** POST /api/subagent-models — partial; omitted fields keep their stored value. */
export interface SubagentSettingsRequest {
  provider?: SubagentProvider;
  omlxBaseUrl?: string;
  maxcoding?: SubagentModelEntry;
  minimodel?: SubagentModelEntry;
}

// ---------------------------------------------------------------------------
// Agents (user-created thread owners)
// ---------------------------------------------------------------------------

/**
 * Where an agent's model comes from. `inceptionlabs` exposes exactly one
 * registered model (INCEPTION_MODEL), so the builder fixes the slug there;
 * the other two accept an arbitrary slug via Pi's thin-overlay registration.
 */
export type AgentModelProvider = "inceptionlabs" | "openrouter" | "omlx";
export const AGENT_MODEL_PROVIDERS: readonly AgentModelProvider[] = [
  "inceptionlabs",
  "openrouter",
  "omlx",
];

/** Category a tool falls into, for grouping the agent builder's checklist. */
export type ToolCategory =
  | "filesystem" | "shell" | "delegation" | "interaction" | "memory"
  | "web" | "git" | "ops" | "artifacts" | "mcp" | "email" | "signal";

/** One row of GET /api/tools. */
export interface ToolInfoRow {
  name: string;
  label: string;
  description: string;
  category: ToolCategory;
  /** Blocked in plan mode. */
  mutating: boolean;
  /** Forced on for every agent; the builder shows it checked and disabled. */
  alwaysOn: boolean;
  /** False when this server lacks the dependency the tool needs. */
  available: boolean;
  unavailableReason?: string;
}

export interface ToolsResponse {
  tools: ToolInfoRow[];
}

/**
 * An agent as the UI sees it. Null `systemPrompt` / `modelProvider` /
 * `modelSlug` / `tools` occur only on a builtin and mean "resolved from code";
 * `resolved` carries what that actually works out to, so the builder can show
 * the effective configuration without duplicating the fallback logic.
 */
export interface AgentDef {
  id: string;
  slug: string;
  name: string;
  description: string;
  avatar: string | null;
  systemPrompt: string | null;
  modelProvider: AgentModelProvider | null;
  modelSlug: string | null;
  /** Null = follow the global ⚙ reasoning-effort setting. */
  reasoningEffort: ReasoningEffort | null;
  maxTokens: number | null;
  tools: string[] | null;
  /** Null = every installed MCP server. */
  mcpServers: string[] | null;
  supportsPlanMode: boolean;
  isBuiltin: boolean;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  /** The effective configuration after code defaults are applied. */
  resolved: {
    modelProvider: AgentModelProvider;
    modelSlug: string;
    reasoningEffort: ReasoningEffort;
    tools: string[];
    /** Null still means "all installed servers". */
    mcpServers: string[] | null;
  };
}

/** POST /api/agents body; PATCH accepts the same fields, all optional. */
export interface AgentDraft {
  slug?: string;
  name: string;
  description?: string;
  avatar?: string | null;
  systemPrompt: string;
  modelProvider: AgentModelProvider;
  modelSlug: string;
  reasoningEffort?: ReasoningEffort | null;
  maxTokens?: number | null;
  tools: string[];
  mcpServers?: string[] | null;
  supportsPlanMode?: boolean;
}

export interface AgentsResponse {
  agents: AgentDef[];
}

/** One selectable model in the agent builder. */
export interface ModelOption {
  provider: AgentModelProvider;
  slug: string;
  label: string;
  /**
   * False means a per-agent reasoning effort would be silently ignored — Pi
   * only emits reasoning_effort for models flagged reasoning-capable, and
   * unknown OpenRouter slugs register as overlays with reasoning: false.
   */
  reasoningCapable: boolean;
  contextWindow: number;
}

export interface ModelsResponse {
  providers: Array<{
    id: AgentModelProvider;
    label: string;
    /** True when the user may type a slug this server has never seen. */
    allowsArbitrarySlug: boolean;
    /** True when the provider's API key is configured. */
    configured: boolean;
    models: ModelOption[];
  }>;
}

// ---------------------------------------------------------------------------
// Schedules
// ---------------------------------------------------------------------------

export type ScheduleStatus = "ok" | "error" | "skipped" | "running";

export interface Schedule {
  id: string;
  agentId: string;
  name: string;
  /** What the agent is told when the schedule fires. */
  prompt: string;
  /** Five-field cron expression. */
  cron: string;
  /** IANA zone, e.g. "America/Los_Angeles". */
  timezone: string;
  mode: ThreadMode;
  enabled: boolean;
  /** After downtime: fire once and re-base (false), or replay missed slots (true). */
  catchUp: boolean;
  webhookUrl: string | null;
  webhookTokenSet: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastRunThreadId: string | null;
  lastStatus: ScheduleStatus | null;
  lastError: string | null;
  /** The next few firings, so the form can show what the cron actually means. */
  nextRuns?: string[];
}

export interface ScheduleDraft {
  agentId: string;
  name: string;
  prompt: string;
  cron: string;
  timezone?: string;
  mode?: ThreadMode;
  enabled?: boolean;
  catchUp?: boolean;
  webhookUrl?: string | null;
  webhookToken?: string;
}

export interface SchedulesResponse {
  schedules: Schedule[];
}

/** GET /api/schedules/preview?cron=&timezone= — validates and explains a cron. */
export interface CronPreviewResponse {
  valid: boolean;
  error?: string;
  nextRuns: string[];
}

// ---------------------------------------------------------------------------
// Inbox
// ---------------------------------------------------------------------------

/** One row of the inbox: a thread, its latest reply, and what it needs. */
export interface InboxItem {
  threadId: string;
  title: string;
  status: ThreadStatus;
  mode: ThreadMode;
  source: ThreadSource;
  scheduleId: string | null;
  /** Null only for threads whose agent row was deleted out from under them. */
  agentId: string | null;
  agentSlug: string;
  agentName: string;
  agentAvatar: string | null;
  /** Truncated latest assistant message, or the app's own status line. */
  preview: string;
  lastMessageAt: string | null;
  unread: boolean;
  /** awaiting_input or awaiting_approval — the thread is blocked on the user. */
  needsYou: boolean;
  error: string | null;
  /** Up to three of the thread's most recent artifacts, for a one-click open. */
  artifacts: Array<{ id: string; name: string; url: string }>;
}

/** GET /api/inbox */
export interface InboxResponse {
  items: InboxItem[];
  unreadByAgent: Record<string, number>;
  totalUnread: number;
}

/** What the inbox list is filtered to. */
export type InboxFilter = "all" | "unread" | "needs_you";

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
// MCP servers
// ---------------------------------------------------------------------------

/**
 * How fastcar talks to an MCP server.
 * - `stdio`: a local process, cloned and built into FASTCAR_MCP_DIR.
 * - `http`:  a deployed server speaking Streamable HTTP (spec 2025-03-26+).
 * - `sse`:   a deployed server speaking the older HTTP+SSE transport
 *            (spec 2024-11-05). Negotiated automatically: an `http` install
 *            that the server rejects falls back to this.
 */
export type McpTransport = "stdio" | "http" | "sse";

/** How a remote MCP server is authenticated. */
export type McpAuth = "none" | "headers" | "oauth";

/** One tool an MCP server advertises, as cached by the registry. */
export interface McpToolInfo {
  name: string;
  description?: string;
  /** JSON Schema for the tool's arguments. */
  inputSchema?: Record<string, unknown>;
  /** MCP tool annotations (readOnlyHint, destructiveHint, ...) when the server sets them. */
  annotations?: Record<string, unknown>;
}

/** Live state of an installed MCP server, for the UI panel and /mcp. */
export interface McpServerStatus {
  name: string;
  /** What it was installed from: a GitHub tree URL, a git URL, or an http endpoint. */
  source: string;
  transport: McpTransport;
  /** Local project directory (stdio servers). */
  path?: string;
  /** Endpoint (http servers). */
  url?: string;
  command?: string;
  args?: string[];
  /** Names of configured env vars — values are never sent to the UI. */
  envKeys: string[];
  /** Names of configured HTTP headers (remote servers) — values are never sent. */
  headerKeys: string[];
  /** How a remote server is authenticated; "none" for local servers. */
  auth: McpAuth;
  /**
   * `needs_auth`: the server wants an OAuth sign-in (first install, or a
   * refresh token that stopped working). `authorizationUrl` is where to send
   * the user.
   */
  status: "connected" | "error" | "stopped" | "needs_auth";
  error?: string;
  /** Sign-in URL, present only while status is `needs_auth`. */
  authorizationUrl?: string;
  tools: McpToolInfo[];
  createdAt: string;
}

/** Body of POST /api/mcp */
export interface InstallMcpRequest {
  /** GitHub tree/blob URL, git URL, or local path (stdio), or an http(s) MCP endpoint with transport "http". */
  source: string;
  name?: string;
  transport?: McpTransport;
  /** Subdirectory inside the repository holding the server (derived from a GitHub tree URL). */
  subpath?: string;
  /** Branch, tag or commit to check out (derived from a GitHub tree URL). */
  ref?: string;
  /** Override the launch command instead of auto-detecting from package.json. */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** Extra HTTP headers for http servers (e.g. Authorization). */
  headers?: Record<string, string>;
}

export interface McpServersResponse {
  servers: McpServerStatus[];
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
  | { type: "create_thread"; mode?: ThreadMode; agentId?: string }
  /** Create a prompt thread (Feature 3): resolve a template, run the LLM, POST the result to the webhook. */
  | {
      type: "create_prompt_thread";
      title?: string;
      templateId: string;
      variables?: Record<string, string>;
      webhookUrl: string;
      webhookToken: string;
    }
  | { type: "rename_thread"; threadId: string; title: string }
  /** Hard delete: the thread, its history, and its agent session all go. */
  | { type: "delete_thread"; threadId: string }
  | { type: "set_mode"; threadId: string; mode: ThreadMode }
  | { type: "answer_question"; threadId: string; questionId: string; answer: string }
  | { type: "approve_plan"; threadId: string }
  | { type: "reject_plan"; threadId: string; feedback: string }
  | { type: "abort"; threadId: string }
  /** Mark a thread read (the inbox's own affordance; opening one also marks it). */
  | { type: "mark_read"; threadId: string }
  | { type: "mark_all_read"; agentId?: string }
  | { type: "steer"; threadId: string; text: string }
  /** Ask the agent to clone a repository into the VM (routed through the conductor). */
  | { type: "add_repo"; url: string; name?: string; threadId?: string }
  /** Structured slash command (Feature 2): `{command:"/email", args:{to,subject,body}}`. */
  | {
      type: "slash";
      threadId?: string;
      command: string;
      args?: Record<string, unknown>;
      /** Admin token for restricted slash commands (e.g. /email). */
      adminToken?: string;
    };

// ---------------------------------------------------------------------------
// Server → Client
// ---------------------------------------------------------------------------

export type ServerMessage =
  | { type: "hello"; threads: ThreadMeta[] }
  | { type: "thread_created"; thread: ThreadMeta }
  | { type: "thread_updated"; thread: ThreadMeta }
  | { type: "thread_deleted"; threadId: string }
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
  /** The set of installed MCP servers, or one of their connection states, changed. */
  | { type: "mcp_servers_updated"; servers: McpServerStatus[] }
  /** An agent was created, edited or archived. */
  | { type: "agents_updated"; agents: AgentDef[] }
  /**
   * Unread counts changed. Per-row updates ride the existing thread_updated
   * broadcast; only the aggregate needs its own message, since the client
   * cannot derive it without holding every thread.
   */
  | { type: "inbox_counts"; unreadByAgent: Record<string, number>; totalUnread: number }
  /** A schedule was created, edited, fired or disabled. */
  | { type: "schedules_updated"; schedules: Schedule[] }
  /** An artifact on the thread was created, updated or deleted (e.g. by the agent). */
  | { type: "artifacts_updated"; threadId: string }
  /** Result of a prompt thread's webhook delivery (Feature 3). */
  | {
      type: "prompt_thread_result";
      threadId: string;
      status: "success" | "error" | "skipped";
      response?: string;
    }
  /** Ack/result of a structured `/email` slash command (Feature 2). */
  | { type: "slash_result"; ok: boolean; message: string }
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
