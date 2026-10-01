/**
 * The catalog of every tool an agent can be granted.
 *
 * Before this existed, "which tools are there" was spread across five
 * `*_TOOL_NAMES` constants and two hand-written literal arrays (the conductor's
 * allowlist and the three subagent presets), and the mutating set was
 * hand-assembled from four more constants. That was fine while both lists were
 * fixed at compile time. It stops being fine the moment a user composes their
 * own allowlist in a form.
 *
 * Entries are per *tool name*, not per factory: an agent must be able to hold
 * `git_status` without `git_push`, and plan-mode gating is per name. Factories
 * that emit several tools (git, memory, artifacts, mcp) are modelled as groups,
 * run once and then indexed by name.
 */
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Config } from "../config.js";
import type { SubagentManager } from "../pi/subagents.js";
import type { ArtifactService } from "../services/artifacts.js";
import type { BrowserSessions } from "../services/browserSessions.js";
import type { EmailService } from "../services/emailService.js";
import type { McpManager } from "../services/mcp.js";
import type { SignalService } from "../services/signal.js";
import { createArtifactTools } from "./artifacts.js";
import { createAskUserTool, type AskUserBridge } from "./askUser.js";
import { createBrowserTools } from "./browser.js";
import { createBrowserCheckTool } from "./browserCheck.js";
import { createEmailTools } from "./email.js";
import { createGitTools } from "./git.js";
import { createHeyctlTools } from "./heyctl.js";
import { createMcpTools } from "./mcp.js";
import { createMemoryTools } from "./memory.js";
import { createReminderTools } from "./reminders.js";
import { createRunSubagentTool, type SubagentEventSink } from "./runSubagent.js";
import { createSignalTools } from "./signal.js";
import { createSubmitPlanTool, type SubmitPlanBridge } from "./submitPlan.js";
import { createWebSearchTool } from "./webSearch.js";

export type ToolCategory =
  | "filesystem"
  | "shell"
  | "delegation"
  | "interaction"
  | "memory"
  | "web"
  | "git"
  | "ops"
  | "artifacts"
  | "mcp"
  | "email"
  | "signal"
  | "reminders";

/** Which optional dependency a tool's factory needs from the ToolContext. */
export type ToolDep =
  | "subagents" | "ask" | "plan" | "email" | "email_inbox" | "artifacts" | "mcp" | "signal" | "browser";

export interface ToolDef {
  name: string;
  /** Human label for the agent builder. */
  label: string;
  /** One line for the agent builder — not the model-facing description. */
  description: string;
  category: ToolCategory;
  /**
   * A Pi builtin (read/bash/edit/write/grep/find/ls): it has no factory, it is
   * enabled purely by naming it in the allowlist.
   */
  builtin: boolean;
  /** Changes state, so it is blocked outright in plan mode. */
  mutating: boolean;
  /**
   * Plan mode inspects this tool's arguments rather than blocking it outright
   * (mcp_call checks readOnlyHint; run_subagent checks the requested agent).
   */
  conditionalInPlanMode?: boolean;
  /** Factory dependency; the tool is dropped when the ToolContext lacks it. */
  requires?: ToolDep;
  /** Group whose factory builds this tool; absent for builtins. */
  group?: ToolGroup;
  /**
   * Forced on for every *user-created agent* (see services/agents.ts).
   * Deliberately NOT honoured by buildToolset: subagent presets must be able to
   * exclude ask_user/submit_plan, since a subagent cannot talk to the user.
   */
  alwaysOnForAgents?: boolean;
}

type ToolGroup =
  | "subagent"
  | "ask"
  | "plan"
  | "memory"
  | "web"
  | "browser"
  | "browser_session"
  | "email"
  | "git"
  | "heyctl"
  | "artifacts"
  | "mcp"
  | "signal"
  | "reminders";

/** Everything a group factory might need. Optional fields mirror ConductorDeps. */
export interface ToolContext {
  cfg: Config;
  threadId: string;
  subagents?: SubagentManager;
  onSubagentEvent?: SubagentEventSink;
  askBridge?: AskUserBridge;
  planBridge?: SubmitPlanBridge;
  email?: EmailService;
  artifacts?: ArtifactService;
  mcp?: McpManager;
  /** MCP servers this agent may reach; undefined means all installed. */
  allowedMcpServers?: string[];
  signal?: SignalService;
  /** Persistent per-thread browser sessions for the browser_* tools. */
  browsers?: BrowserSessions;
}

const GROUP_FACTORIES: Record<ToolGroup, (ctx: ToolContext) => ToolDefinition[]> = {
  subagent: (c) => [createRunSubagentTool(c.subagents!, c.onSubagentEvent!)],
  ask: (c) => [createAskUserTool(c.askBridge!)],
  plan: (c) => [createSubmitPlanTool(c.planBridge!)],
  memory: (c) => createMemoryTools(c.threadId),
  web: (c) => [createWebSearchTool(c.cfg)],
  browser: (c) => [createBrowserCheckTool(c.cfg)],
  browser_session: (c) => createBrowserTools(c.browsers!, c.threadId, c.cfg.workdir),
  email: (c) => createEmailTools(c.email!),
  git: (c) => createGitTools(c.cfg),
  heyctl: () => createHeyctlTools(),
  artifacts: (c) => createArtifactTools(c.artifacts!, c.threadId),
  mcp: (c) => createMcpTools(c.mcp!, c.allowedMcpServers),
  signal: (c) => createSignalTools(c.signal!, c.cfg.workdir),
  reminders: (c) => createReminderTools(c.threadId),
};

/** True when the context carries what this tool's factory needs. */
function depSatisfied(def: ToolDef, ctx: ToolContext): boolean {
  switch (def.requires) {
    case undefined:
      return true;
    case "subagents":
      return Boolean(ctx.subagents && ctx.onSubagentEvent);
    case "ask":
      return Boolean(ctx.askBridge);
    case "plan":
      return Boolean(ctx.planBridge);
    // Configured state, not mere presence: EmailService always exists, and an
    // agent offered a tool that can only fail learns nothing from it. Sessions
    // are rebuilt when the settings change (ThreadManager.markAllSessionsStale).
    case "email":
      return Boolean(ctx.email?.smtpConfigured());
    case "email_inbox":
      return Boolean(ctx.email?.imapConfigured());
    case "artifacts":
      return Boolean(ctx.artifacts);
    case "mcp":
      return Boolean(ctx.mcp);
    case "signal":
      return Boolean(ctx.signal);
    case "browser":
      return Boolean(ctx.browsers?.available());
  }
}

const b = (
  name: string,
  label: string,
  description: string,
  category: ToolCategory,
  mutating = false,
): ToolDef => ({ name, label, description, category, builtin: true, mutating });

export const TOOLS: readonly ToolDef[] = [
  // ---- Pi builtins: allowlist-only, no factory -----------------------------
  b("read", "Read file", "Read a file from the workspace.", "filesystem"),
  b("bash", "Run shell", "Run a shell command in the VM.", "shell", true),
  b("edit", "Edit file", "Apply a targeted edit to a file.", "filesystem", true),
  b("write", "Write file", "Create or overwrite a file.", "filesystem", true),
  b("grep", "Grep", "Search file contents by pattern.", "filesystem"),
  b("find", "Find files", "Find files by name or glob.", "filesystem"),
  b("ls", "List directory", "List a directory's contents.", "filesystem"),

  // ---- Orchestration and user interaction ---------------------------------
  {
    name: "run_subagent",
    label: "Delegate to subagents",
    description: "Hand work to the maxcoding and minimodel subagents, in parallel if needed.",
    category: "delegation",
    builtin: false,
    mutating: false,
    conditionalInPlanMode: true,
    requires: "subagents",
    group: "subagent",
  },
  {
    name: "ask_user",
    label: "Ask the user",
    description: "Pause the thread and ask a clarifying question.",
    category: "interaction",
    builtin: false,
    mutating: false,
    requires: "ask",
    group: "ask",
    alwaysOnForAgents: true,
  },
  {
    name: "submit_plan",
    label: "Submit a plan",
    description: "Submit a plan for approval. Required for plan mode to terminate.",
    category: "interaction",
    builtin: false,
    mutating: false,
    requires: "plan",
    group: "plan",
    alwaysOnForAgents: true,
  },

  // ---- Memory --------------------------------------------------------------
  m("memory_save", "Save memory", "Persist a durable fact for future sessions."),
  m("memory_search", "Search memory", "Full-text search over saved memories."),
  m("memory_list", "List memories", "List recent memories."),
  m("memory_delete", "Delete memory", "Delete a saved memory.", true),

  // ---- Reminders -----------------------------------------------------------
  // Only touches fastcar's own state (like memory_save), so plan mode allows
  // it; a reminder that fires in plan mode is still gated like any turn.
  r("reminder_create", "Set reminder", "Schedule a follow-up that wakes this thread later."),
  r("reminder_list", "List reminders", "List this thread's pending reminders."),
  r("reminder_cancel", "Cancel reminder", "Cancel a pending reminder."),

  // ---- Web -----------------------------------------------------------------
  {
    name: "web_search",
    label: "Web search",
    description: "Search the web via Tavily.",
    category: "web",
    builtin: false,
    mutating: false,
    group: "web",
  },
  {
    name: "browser_check",
    label: "Browser check",
    description: "Drive a headless Chromium against a URL and report JS/console/network errors.",
    category: "web",
    builtin: false,
    mutating: false,
    group: "browser",
  },

  // ---- Browser sessions ------------------------------------------------------
  // A persistent headless browser per thread. Only acting on a page can
  // change anything (it submits forms), so plan mode keeps read-only browsing.
  w("browser_open", "Open web page", "Load a URL in a persistent headless browser session.", false),
  w("browser_snapshot", "Snapshot page", "Read the page as an accessibility tree with element refs.", false),
  w("browser_act", "Act on page", "Click, type, select and submit on a page — fills forms.", true),
  w("browser_extract", "Extract from page", "Pull text, links, tables or form fields from a page.", false),
  w("browser_screenshot", "Screenshot page", "Save a PNG of the current page.", false),
  w("browser_tabs", "Browser tabs", "List, switch or close browser tabs.", false),
  w("browser_close", "Close browser", "End the browser session and forget its cookies.", false),

  // ---- Email ---------------------------------------------------------------
  // Sending reaches real people, so it is blocked in plan mode; reading only
  // touches fastcar's copy of the mailbox.
  e("email_list", "List email", "List email threads with unread counts.", false, "email_inbox"),
  e("email_read", "Read email", "Read an email thread, optionally waiting for new mail.", false, "email_inbox"),
  e("email_send", "Send email", "Send an email or a threaded reply over SMTP.", true, "email"),

  // ---- Signal --------------------------------------------------------------
  // Sending reaches real people, so it is blocked in plan mode; reading and
  // listing only touch fastcar's own copy of the history.
  s("signal_threads", "Signal threads", "List Signal conversations, groups and contacts.", false),
  s("signal_read", "Read Signal thread", "Read a Signal thread, optionally waiting for a reply.", false),
  s("signal_send", "Send Signal message", "Send a Signal message to a person or group.", true),

  // ---- Git -----------------------------------------------------------------
  g("git_clone", "Clone repository", "Clone a repository into the VM and register it.", true),
  g("git_pull", "Pull", "Pull the current branch.", true),
  g("git_checkout", "Checkout", "Switch or create a branch.", true),
  g("git_commit", "Commit", "Commit staged and unstaged changes.", true),
  g("git_push", "Push", "Push the current branch to its remote.", true),
  g("git_status", "Git status", "Report branch, dirty state and ahead/behind.", false),
  g("git_purge", "Purge repository", "Delete a clone and deregister it.", true),
  g("git_list_repos", "List repositories", "List every registered repository.", false),

  // ---- Ops -----------------------------------------------------------------
  {
    name: "heyctl",
    label: "heyctl (app-lb)",
    description:
      "Drive app-lb's admin API: deployments, microVM pools, certificates, secrets, jobs, disks. " +
      "The tool cannot tell read verbs from write verbs, so all of it is blocked in plan mode.",
    category: "ops",
    builtin: false,
    mutating: true,
    group: "heyctl",
  },

  // ---- Artifacts -----------------------------------------------------------
  a("create_artifact", "Create artifact", "Publish a page or document on a public URL.", true),
  a("update_artifact", "Update artifact", "Replace an artifact's content in place.", true),
  a("list_artifacts", "List artifacts", "List this thread's artifacts.", false),

  // ---- MCP -----------------------------------------------------------------
  p("mcp_install", "Install MCP server", "Install an MCP server from a URL and register it.", true),
  p("mcp_remove", "Remove MCP server", "Uninstall an MCP server.", true),
  p("mcp_list_servers", "List MCP servers", "List installed MCP servers.", false),
  p("mcp_list_tools", "List MCP tools", "List a server's tools and argument schemas.", false),
  {
    name: "mcp_call",
    label: "Call an MCP tool",
    description: "Invoke a tool on an installed MCP server.",
    category: "mcp",
    builtin: false,
    mutating: false,
    conditionalInPlanMode: true,
    requires: "mcp",
    group: "mcp",
  },
];

function m(name: string, label: string, description: string, mutating = false): ToolDef {
  return { name, label, description, category: "memory", builtin: false, mutating, group: "memory" };
}
function r(name: string, label: string, description: string): ToolDef {
  return { name, label, description, category: "reminders", builtin: false, mutating: false, group: "reminders" };
}
function g(name: string, label: string, description: string, mutating: boolean): ToolDef {
  return { name, label, description, category: "git", builtin: false, mutating, group: "git" };
}
function a(name: string, label: string, description: string, mutating: boolean): ToolDef {
  return {
    name, label, description, category: "artifacts",
    builtin: false, mutating, requires: "artifacts", group: "artifacts",
  };
}
function w(name: string, label: string, description: string, mutating: boolean): ToolDef {
  return {
    name, label, description, category: "web",
    builtin: false, mutating, requires: "browser", group: "browser_session",
  };
}
function e(name: string, label: string, description: string, mutating: boolean, requires: ToolDep): ToolDef {
  return { name, label, description, category: "email", builtin: false, mutating, requires, group: "email" };
}
function s(name: string, label: string, description: string, mutating: boolean): ToolDef {
  return {
    name, label, description, category: "signal",
    builtin: false, mutating, requires: "signal", group: "signal",
  };
}
function p(name: string, label: string, description: string, mutating: boolean): ToolDef {
  return {
    name, label, description, category: "mcp",
    builtin: false, mutating, requires: "mcp", group: "mcp",
  };
}

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

export function getTool(name: string): ToolDef | undefined {
  return BY_NAME.get(name);
}

/** Every tool in a group, in catalog order. */
export function namesInGroup(group: string): string[] {
  return TOOLS.filter((t) => t.group === group).map((t) => t.name);
}

/** Blocked outright while a thread is in plan mode. */
export const MUTATING_TOOL_NAMES: ReadonlySet<string> = new Set(
  TOOLS.filter((t) => t.mutating).map((t) => t.name),
);

/** Gated in plan mode by inspecting call arguments rather than by name. */
export const CONDITIONAL_PLAN_TOOLS: ReadonlySet<string> = new Set(
  TOOLS.filter((t) => t.conditionalInPlanMode).map((t) => t.name),
);

export function isMutating(name: string): boolean {
  return MUTATING_TOOL_NAMES.has(name);
}

/**
 * Resolve an allowlist into the two arrays createAgentSession wants.
 *
 * Pi fixes a session's tool registry at creation and an allowlist naming only
 * builtins disables every custom tool, so `tools` and `customTools` have to
 * agree exactly. Returning both from one resolved set is what makes that
 * structural rather than a thing to remember.
 *
 * Unknown names and names whose dependency is missing are dropped and reported
 * in `dropped` — matching today's behaviour, where the conductor simply omits
 * `email` when no EmailService is wired in.
 */
export function buildToolset(
  allowlist: readonly string[],
  ctx: ToolContext,
): { tools: string[]; customTools: ToolDefinition[]; dropped: string[] } {
  const tools: string[] = [];
  const dropped: string[] = [];
  const groupsNeeded = new Set<ToolGroup>();
  const seen = new Set<string>();

  for (const name of allowlist) {
    if (seen.has(name)) continue;
    const def = BY_NAME.get(name);
    if (!def || !depSatisfied(def, ctx)) {
      dropped.push(name);
      continue;
    }
    seen.add(name);
    tools.push(name);
    if (def.group) groupsNeeded.add(def.group);
  }

  // Run each factory once, then keep only the instances the allowlist named —
  // a group factory always emits its whole set (createGitTools returns all
  // eight), so an agent granted `git_status` alone must not receive `git_push`.
  const customTools: ToolDefinition[] = [];
  for (const group of groupsNeeded) {
    for (const tool of GROUP_FACTORIES[group](ctx)) {
      if (seen.has(tool.name)) customTools.push(tool);
    }
  }

  return { tools, customTools, dropped };
}

/** Shape served by GET /api/tools for the agent builder. */
export interface ToolInfoRow {
  name: string;
  label: string;
  description: string;
  category: ToolCategory;
  mutating: boolean;
  alwaysOn: boolean;
  /** False when the server is running without the dependency this tool needs. */
  available: boolean;
  unavailableReason?: string;
}

/**
 * Which optional services this server process actually has. Only these
 * vary per deployment; the subagent manager and the ask/plan bridges are
 * created per session by the agent factory, so from the catalog's point of
 * view they are always available.
 */
export interface ServerCapabilities {
  /** SMTP is configured. */
  email: boolean;
  /** IMAP is configured. */
  emailInbox: boolean;
  /** A Chromium binary exists. */
  browser: boolean;
  artifacts: boolean;
  mcp: boolean;
  signal: boolean;
}

const DEP_REASON: Partial<Record<ToolDep, string>> = {
  email: "no SMTP server is configured",
  email_inbox: "no IMAP server is configured (Settings → Email)",
  browser: "no Chromium binary found (install chromium or set FASTCAR_CHROMIUM_PATH)",
  artifacts: "the artifact store is not available",
  mcp: "the MCP registry is not available",
  signal: "Signal is not configured (set SIGNAL_ACCOUNT)",
};

export function listTools(caps: ServerCapabilities): ToolInfoRow[] {
  return TOOLS.map((t) => {
    const dep = t.requires;
    const available =
      dep === "email" || dep === "artifacts" || dep === "mcp" || dep === "signal" || dep === "browser"
        ? caps[dep]
        : dep === "email_inbox"
          ? caps.emailInbox
          : true;
    return {
      name: t.name,
      label: t.label,
      description: t.description,
      category: t.category,
      mutating: t.mutating,
      alwaysOn: Boolean(t.alwaysOnForAgents),
      available,
      ...(available ? {} : { unavailableReason: DEP_REASON[dep!] }),
    };
  });
}

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

/**
 * The conductor's allowlist, moved verbatim from conductor.ts (order included)
 * so the seeded builtin agent grants exactly what it granted before, plus the
 * tools added since (appended, so the old prefix is untouched). The one
 * in-place change is `email` → `email_send`, a rename when email learned to
 * read (migration 011 renames it in stored agents too). Tools whose
 * dependency is absent are dropped by buildToolset, which is what the
 * conditional spreads in conductor.ts used to do by hand.
 */
export const CONDUCTOR_DEFAULT_TOOLS: readonly string[] = [
  "read", "bash", "edit", "write", "grep", "find", "ls",
  "run_subagent", "ask_user", "submit_plan",
  "memory_save", "memory_search", "memory_list", "memory_delete",
  "web_search", "browser_check", "email_send",
  ...namesInGroup("git"),
  "heyctl",
  ...namesInGroup("artifacts"),
  ...namesInGroup("mcp"),
  // Dropped by buildToolset unless SIGNAL_ACCOUNT is set.
  ...namesInGroup("signal"),
  // Dropped unless IMAP is configured.
  "email_list", "email_read",
  // Dropped when no Chromium is installed.
  ...namesInGroup("browser_session"),
  ...namesInGroup("reminders"),
];

/** Read-only git, derived rather than hand-listed: git_status + git_list_repos. */
const READ_ONLY_GIT_TOOLS = namesInGroup("git").filter((n) => !isMutating(n));
/** The MCP tools that only inspect: mcp_list_servers + mcp_list_tools. */
const MCP_READONLY = ["mcp_list_servers", "mcp_list_tools"];

export type SubagentPool = "maxcoding" | "maxcoding:plan" | "minimodel";

/**
 * Subagent tool presets, moved verbatim from subagents.ts. These deliberately
 * exclude ask_user and submit_plan even though those are `alwaysOnForAgents`:
 * a subagent cannot talk to the user. buildToolset could not grant them here
 * anyway, since a subagent's ToolContext carries no bridges.
 */
export const SUBAGENT_PRESETS: Record<SubagentPool, readonly string[]> = {
  // maxcoding gets git except clone and purge — the repository registry's
  // lifecycle stays with the conductor, which can ask the user about it. The
  // same split applies to MCP: it can call installed servers, not install them.
  maxcoding: [
    "read", "bash", "edit", "write", "grep", "find", "ls", "web_search", "browser_check",
    ...namesInGroup("git").filter((n) => n !== "git_clone" && n !== "git_purge"),
    "heyctl",
    ...MCP_READONLY, "mcp_call",
  ],
  // Planning maxcoding must not be able to change anything — no bash either,
  // since bash can mutate. This is what lets the conductor run it in plan mode.
  // heyctl is included because its read verbs are how a planning run inspects
  // app-lb state; the tool itself cannot tell read from write, so the plan
  // prompt forbids mutating subcommands there.
  "maxcoding:plan": [
    "read", "grep", "find", "ls", "web_search", ...READ_ONLY_GIT_TOOLS,
    "heyctl", ...MCP_READONLY,
  ],
  minimodel: ["read", "grep", "find", "ls", "web_search", ...READ_ONLY_GIT_TOOLS, ...MCP_READONLY],
};

/**
 * Using one of these means a subagent changed something, so it owes a
 * `## Verification` section. Distinct from MUTATING_TOOL_NAMES on purpose:
 * that set gates plan mode, this one is evidence that a change happened, and
 * widening it would change when the verification reminder fires.
 */
export const CHANGE_EVIDENCE_TOOLS: readonly string[] = ["edit", "write", "bash"];

/** Fail at boot on a typo in a preset rather than silently losing a tool. */
for (const [pool, names] of Object.entries(SUBAGENT_PRESETS)) {
  for (const n of names) {
    if (!BY_NAME.has(n)) throw new Error(`SUBAGENT_PRESETS.${pool} names unknown tool "${n}"`);
  }
}
for (const n of CONDUCTOR_DEFAULT_TOOLS) {
  if (!BY_NAME.has(n)) throw new Error(`CONDUCTOR_DEFAULT_TOOLS names unknown tool "${n}"`);
}
