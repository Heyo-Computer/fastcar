/**
 * Slash commands.
 *
 * The registry is the single source of truth: the composer's `/` menu is served
 * from it (GET /api/commands), and the ThreadManager dispatches through it, so
 * the menu can never offer something the server cannot run.
 *
 * Server commands run here and render markdown into the thread as a `system`
 * event. The handful of client commands act on the UI (creating and selecting a
 * thread) and carry no `run` — the browser handles those.
 */
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { CommandSpec, ThreadMode } from "@fastcar/shared";
import type { Config } from "../config.js";
import { listMemories, searchMemories } from "../db/memories.js";
import { listAgents } from "../pi/agentsConfig.js";
import { collectRepoStatuses, purgeRepo, PurgeRefusedError } from "../services/git.js";
import type { McpManager } from "../services/mcp.js";

export interface CommandContext {
  cfg: Config;
  threadId: string;
  /** Everything after the command name, trimmed. */
  args: string;
  mode: ThreadMode;
  /** The thread's conductor session, or null if it has not been created yet. */
  session: AgentSession | null;
  setMode: (mode: ThreadMode) => Promise<void>;
  /** Rename this thread; resolves with the cleaned-up title. */
  rename: (title: string) => Promise<string>;
  /** MCP registry, when the server runs with one. */
  mcp?: McpManager;
}

interface CommandDef extends CommandSpec {
  run?: (ctx: CommandContext) => Promise<string>;
}

const NO_SESSION = "This thread has no agent session yet — send a message first.";

const num = (n: number | null | undefined): string =>
  n == null ? "?" : Math.round(n).toLocaleString("en-US");

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;
}

/** "3d" / "5mo" / "just now" — enough to spot a stale clone at a glance. */
export function relativeAge(iso: string | undefined): string {
  if (!iso) return "no commits";
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (!Number.isFinite(days)) return "unknown";
  if (days <= 0) return "today";
  if (days === 1) return "1 day ago";
  if (days < 30) return `${days} days ago`;
  if (days < 365) return `${Math.floor(days / 30)} months ago`;
  return `${Math.floor(days / 365)} years ago`;
}

function modelFor(cfg: Config, agent: string): string | undefined {
  if (agent === "maxcoding") return cfg.maxcodingModel;
  if (agent === "minimodel") return cfg.minimodelModel;
  return undefined;
}

const COMMANDS: CommandDef[] = [
  {
    name: "help",
    summary: "List every slash command",
    scope: "server",
    aliases: ["commands", "?"],
    run: async () => {
      const lines = COMMANDS.map((c) => {
        const usage = `\`/${c.name}${c.argHint ? ` ${c.argHint}` : ""}\``;
        return `- ${usage} — ${c.summary}`;
      });
      return [
        "### Slash commands",
        ...lines,
        "",
        "Type `@` to reference a subagent, repository, file, or directory.",
      ].join("\n");
    },
  },
  {
    name: "context",
    summary: "Context window usage, token totals, and cost for this thread",
    scope: "server",
    aliases: ["stats"],
    run: async ({ session, mode }) => {
      if (!session) return NO_SESSION;
      const stats = session.getSessionStats();
      const usage = session.getContextUsage() ?? stats.contextUsage;
      const lines = [
        "### Context",
        `- Model: \`${session.model?.id ?? "unknown"}\` · mode **${mode}**`,
      ];
      if (usage) {
        const pct = usage.percent == null ? "?" : `${usage.percent.toFixed(1)}%`;
        lines.push(
          `- Context: ${num(usage.tokens)} / ${num(usage.contextWindow)} tokens (${pct})`,
        );
      }
      lines.push(
        `- Messages: ${stats.userMessages} user · ${stats.assistantMessages} assistant · ${stats.toolCalls} tool calls`,
        `- Tokens: ${num(stats.tokens.input)} in · ${num(stats.tokens.output)} out · ${num(stats.tokens.cacheRead)} cache read`,
        `- Cost so far: $${stats.cost.toFixed(4)}`,
      );
      return lines.join("\n");
    },
  },
  {
    name: "compact",
    summary: "Summarize older context to free up the context window",
    argHint: "[what to focus the summary on]",
    scope: "server",
    aliases: ["compaction"],
    run: async ({ session, args }) => {
      if (!session) return NO_SESSION;
      const usage = session.getContextUsage();
      const before = usage?.tokens ?? null;
      let result;
      try {
        result = await session.compact(args || undefined);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // Too little history to summarize is an expected answer, not a failure.
        if (!/nothing to compact/i.test(message)) throw err;
        return `Nothing to compact yet — the context holds ${num(before)}${
          usage ? ` of ${num(usage.contextWindow)}` : ""
        } tokens.`;
      }
      const after = result.estimatedTokensAfter ?? session.getContextUsage()?.tokens ?? null;
      return [
        "### Context compacted",
        `- Before: ${num(result.tokensBefore || before)} tokens`,
        `- After: ~${num(after)} tokens`,
        "",
        "The chat history above is unchanged — only what the agent carries forward was summarized.",
        "",
        "> " + truncate(result.summary, 800).replace(/\n/g, "\n> "),
      ].join("\n");
    },
  },
  {
    name: "repos",
    summary: "Registered repositories with live git status",
    scope: "server",
    run: async () => {
      const repos = await collectRepoStatuses();
      if (!repos.length) return "No repositories registered yet — add one from the sidebar.";
      const lines = repos.map((r) => {
        const flags = [
          r.missing ? "**missing on disk**" : null,
          r.dirty ? "uncommitted changes" : null,
          (r.ahead ?? 0) > 0 ? `↑${r.ahead}` : null,
          (r.behind ?? 0) > 0 ? `↓${r.behind}` : null,
          `last commit ${relativeAge(r.lastCommitAt)}`,
        ].filter(Boolean);
        return `- **${r.name}** \`${r.branch ?? "?"}\` — \`${r.path}\`${flags.length ? ` · ${flags.join(" · ")}` : ""}`;
      });
      return ["### Repositories", ...lines, "", "Free space with `/purge <name>`."].join("\n");
    },
  },
  {
    name: "mcp",
    summary: "Installed MCP servers and their tools",
    scope: "server",
    run: async ({ mcp }) => {
      if (!mcp) return "MCP is not enabled on this server.";
      const servers = await mcp.statuses();
      if (!servers.length) {
        return "No MCP servers installed — ask the agent to install one from a GitHub URL, or add it from the sidebar.";
      }
      const lines = servers.map((s) => {
        const state = s.status === "connected" ? "connected" : `**${s.status}**${s.error ? ` — ${truncate(s.error, 160)}` : ""}`;
        const tools = s.tools.map((t) => `\`${t.name}\``).join(" · ") || "_no tools advertised_";
        return `- **${s.name}** (${s.transport}, ${state})\n  ${tools}`;
      });
      return ["### MCP servers", ...lines].join("\n");
    },
  },
  {
    name: "purge",
    summary: "Delete a repository clone from the VM; no argument lists the oldest first",
    argHint: "[repo] [--force]",
    scope: "server",
    run: async ({ cfg, args }) => {
      const force = /(?:^|\s)--force(?:\s|$)/.test(args);
      const name = args.replace(/(?:^|\s)--force(?=\s|$)/g, "").trim();

      if (!name) {
        const repos = await collectRepoStatuses();
        if (!repos.length) return "No repositories registered — nothing to purge.";
        const oldest = [...repos].sort((a, b) => (a.lastCommitAt ?? "") .localeCompare(b.lastCommitAt ?? ""));
        const lines = oldest.map((r) => {
          const holds = [
            r.dirty ? "uncommitted changes" : null,
            (r.ahead ?? 0) > 0 ? `${r.ahead} unpushed` : null,
            r.missing ? "missing on disk" : null,
          ].filter(Boolean);
          return `- **${r.name}** — last commit ${relativeAge(r.lastCommitAt)}${holds.length ? ` · ${holds.join(", ")}` : ""}`;
        });
        return [
          "### Repositories, oldest first",
          ...lines,
          "",
          "Purge one with `/purge <name>`. Repositories holding uncommitted changes or commits that are on no remote are refused until you add `--force`.",
        ].join("\n");
      }

      try {
        const result = await purgeRepo(cfg, name, { force });
        return result.registryOnly
          ? `Deregistered **${name}**. Its files at \`${result.path}\` were left alone — they live outside the managed repos directory.`
          : `Purged **${name}** — deleted \`${result.path}\` and dropped it from the registry.`;
      } catch (err) {
        // A refusal is an answer, not a failure: say what is in the way.
        if (err instanceof PurgeRefusedError) {
          return `**${name}** was not purged — it has ${err.reasons.join(" and ")}.\n\nPush or discard the work first, or run \`/purge ${name} --force\` to delete it anyway.`;
        }
        throw err;
      }
    },
  },
  {
    name: "memories",
    summary: "List saved memories, or search them",
    argHint: "[query]",
    scope: "server",
    run: async ({ args }) => {
      const memories = args ? await searchMemories(args, 20) : await listMemories(20);
      if (!memories.length) {
        return args ? `No memories match \`${args}\`.` : "No memories saved yet.";
      }
      const lines = memories.map(
        (m) => `- ${truncate(m.content, 300)}${m.tags.length ? ` _[${m.tags.join(", ")}]_` : ""}`,
      );
      return [`### Memories${args ? ` matching \`${args}\`` : ""}`, ...lines].join("\n");
    },
  },
  {
    name: "agents",
    summary: "Subagents the conductor can delegate to, and their models",
    scope: "server",
    run: async ({ cfg }) => {
      const lines = listAgents().map((a) => {
        const model = modelFor(cfg, a.name);
        return `- **${a.name}**${model ? ` \`${model}\`` : ""} — ${a.description || "no description"}`;
      });
      if (!lines.length) return "No subagents configured in agents.yaml.";
      return ["### Subagents", ...lines, "", "Reference one in a message with `@name`."].join("\n");
    },
  },
  {
    name: "tools",
    summary: "Tools currently available to the conductor",
    scope: "server",
    run: async ({ session }) => {
      if (!session) return NO_SESSION;
      const names = session.getActiveToolNames();
      if (!names.length) return "The conductor has no active tools.";
      return `### Tools (${names.length})\n${names.map((n) => `\`${n}\``).join(" · ")}`;
    },
  },
  {
    name: "rename",
    summary: "Rename this thread",
    argHint: "<title>",
    scope: "server",
    aliases: ["title"],
    run: async ({ args, rename }) => {
      if (!args) return "Give the thread a name: `/rename Refactor the parser`.";
      return `Thread renamed to **${await rename(args)}**.`;
    },
  },
  {
    name: "plan",
    summary: "Switch this thread to planning mode (read-only until you approve)",
    scope: "server",
    run: async ({ mode, setMode }) => {
      if (mode === "plan") return "Already in planning mode.";
      await setMode("plan");
      return "Switched to **planning mode** — the agent will explore read-only and propose a plan.";
    },
  },
  {
    name: "act",
    summary: "Switch this thread to act mode",
    scope: "server",
    run: async ({ mode, setMode }) => {
      if (mode === "act") return "Already in act mode.";
      await setMode("act");
      return "Switched to **act mode** — the agent can make changes again.";
    },
  },
  {
    name: "new",
    summary: "Start a new thread (`/new plan` for a planning thread)",
    argHint: "[plan|act]",
    scope: "client",
  },
  {
    name: "email",
    summary: "Send an email via the configured SMTP server (admin only)",
    argHint: "<to> <subject> <body>",
    scope: "server",
    run: async ({ args }) => {
      // Plain-text `/email` invocation: split into to, subject, body. The
      // structured `{type:"slash"}` form is handled in the WS handler with a
      // proper object; this is the fallback for typed/pasted commands.
      const parts = args.match(/^(\S+)\s+(.*?)\s+([\s\S]+)$/);
      if (!parts) {
        return "Usage: `/email to@x.com Subject line Message body` (or use the structured slash command).";
      }
      return `Use the structured slash command to send: \`/email ${parts[1]} ${parts[2]}\` is queued.`;
    },
  },
];

/** What the composer's `/` menu is built from. */
export const COMMAND_SPECS: CommandSpec[] = COMMANDS.map(
  ({ name, summary, argHint, scope, aliases }) => ({ name, summary, argHint, scope, aliases }),
);

export function findCommand(name: string): CommandDef | undefined {
  const key = name.replace(/^\//, "").toLowerCase();
  return COMMANDS.find((c) => c.name === key || c.aliases?.includes(key));
}

/** Split "/compact focus on the API" into its name and argument string. */
export function parseCommandLine(text: string): { name: string; args: string } | null {
  const match = /^\/([a-z?][\w-]*)\s*([\s\S]*)$/i.exec(text.trim());
  if (!match) return null;
  return { name: match[1]!.toLowerCase(), args: match[2]!.trim() };
}

export async function runCommand(name: string, ctx: CommandContext): Promise<string> {
  const command = findCommand(name);
  if (!command) {
    return `Unknown command \`/${name}\`. Type \`/help\` to see what is available.`;
  }
  if (!command.run) {
    // A client command reached the server — the browser should have handled it.
    return `\`/${command.name}\` is handled by the app, not the agent.`;
  }
  return command.run(ctx);
}
