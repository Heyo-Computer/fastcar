import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { Config } from "../config.js";
import { listRepos } from "../db/repos.js";
import {
  checkoutBranch,
  cloneRepo,
  commitRepo,
  pullRepo,
  purgeRepo,
  pushRepo,
  repoStatusText,
} from "../services/git.js";

const REPO_PARAM = Type.String({
  description: "Name of a registered repository (see git_list_repos)",
});

export function createGitTools(cfg: Config) {
  const clone = defineTool({
    name: "git_clone",
    label: "Git Clone",
    description:
      "Clone a git repository into the VM's repos directory and register it. Use an https URL (a token may be embedded) or an ssh URL if the VM has keys. Returns the registered name and default branch.",
    parameters: Type.Object({
      url: Type.String({ description: "Repository URL (https or ssh)" }),
      name: Type.Optional(
        Type.String({ description: "Optional local name; defaults to the repo's basename" }),
      ),
    }),
    execute: async (_id, params, signal) => {
      const repo = await cloneRepo(cfg, params.url, params.name, signal);
      return {
        content: [
          {
            type: "text",
            text: `Cloned ${params.url} → ${repo.path} (registered as "${repo.name}", default branch: ${repo.defaultBranch ?? "unknown"})`,
          },
        ],
        details: { name: repo.name, path: repo.path },
      };
    },
  });

  const pull = defineTool({
    name: "git_pull",
    label: "Git Pull",
    description: "Fast-forward pull the current branch of a registered repository.",
    parameters: Type.Object({ repo: REPO_PARAM }),
    execute: async (_id, params, signal) => {
      const out = await pullRepo(params.repo, signal);
      return { content: [{ type: "text", text: out || "Already up to date." }], details: {} };
    },
  });

  const checkout = defineTool({
    name: "git_checkout",
    label: "Git Checkout",
    description: "Switch a registered repository to a branch, optionally creating it.",
    parameters: Type.Object({
      repo: REPO_PARAM,
      branch: Type.String({ description: "Branch name" }),
      create: Type.Optional(Type.Boolean({ description: "Create the branch (default false)" })),
    }),
    execute: async (_id, params, signal) => {
      const out = await checkoutBranch(params.repo, params.branch, params.create ?? false, signal);
      return {
        content: [{ type: "text", text: out || `On branch ${params.branch}` }],
        details: {},
      };
    },
  });

  const commit = defineTool({
    name: "git_commit",
    label: "Git Commit",
    description:
      "Commit changes in a registered repository. By default stages everything first (git add -A).",
    parameters: Type.Object({
      repo: REPO_PARAM,
      message: Type.String({ description: "Commit message" }),
      addAll: Type.Optional(
        Type.Boolean({ description: "Stage all changes before committing (default true)" }),
      ),
    }),
    execute: async (_id, params, signal) => {
      const out = await commitRepo(cfg, params.repo, params.message, params.addAll ?? true, signal);
      return { content: [{ type: "text", text: out }], details: {} };
    },
  });

  const push = defineTool({
    name: "git_push",
    label: "Git Push",
    description:
      "Push the current branch of a registered repository to origin (sets upstream on first push).",
    parameters: Type.Object({ repo: REPO_PARAM }),
    execute: async (_id, params, signal) => {
      const out = await pushRepo(params.repo, signal);
      return { content: [{ type: "text", text: out }], details: {} };
    },
  });

  const status = defineTool({
    name: "git_status",
    label: "Git Status",
    description:
      "Show branch, working-tree status, and recent commits for a registered repository.",
    parameters: Type.Object({ repo: REPO_PARAM }),
    execute: async (_id, params) => {
      const out = await repoStatusText(params.repo);
      return { content: [{ type: "text", text: out }], details: {} };
    },
  });

  const purge = defineTool({
    name: "git_purge",
    label: "Purge Repository",
    description:
      "Delete a registered repository's clone from the VM and drop it from the registry — use it to reclaim space from repositories that are no longer needed. Refuses when the clone holds uncommitted changes or commits that exist on no remote; commit and push first, or tell the user to force the purge from the Repositories panel. This cannot be undone: confirm with the user (ask_user) before purging anything you were not explicitly asked to remove.",
    parameters: Type.Object({ repo: REPO_PARAM }),
    execute: async (_id, params) => {
      // Never force from a tool call — destructive overrides stay with the user.
      const result = await purgeRepo(cfg, params.repo);
      return {
        content: [
          {
            type: "text",
            text: result.registryOnly
              ? `Deregistered "${result.name}". Files at ${result.path} were left in place (outside the managed repos directory).`
              : `Purged "${result.name}": deleted ${result.path} and removed it from the registry.`,
          },
        ],
        details: { name: result.name, registryOnly: result.registryOnly },
      };
    },
  });

  const list = defineTool({
    name: "git_list_repos",
    label: "List Repositories",
    description: "List the repositories registered in this VM (name, url, path, default branch).",
    parameters: Type.Object({}),
    execute: async () => {
      const repos = await listRepos();
      const text = repos.length
        ? repos
            .map((r) => `- ${r.name} — ${r.url} (${r.path}, default: ${r.defaultBranch ?? "?"})`)
            .join("\n")
        : "No repositories registered yet. Use git_clone to add one.";
      return { content: [{ type: "text", text }], details: { count: repos.length } };
    },
  });

  return [clone, pull, checkout, commit, push, status, purge, list];
}

export const GIT_TOOL_NAMES = [
  "git_clone",
  "git_pull",
  "git_checkout",
  "git_commit",
  "git_push",
  "git_status",
  "git_purge",
  "git_list_repos",
];

/** Git tools that mutate repository state (blocked in plan mode). */
export const GIT_MUTATING_TOOLS = [
  "git_clone",
  "git_pull",
  "git_checkout",
  "git_commit",
  "git_push",
  "git_purge",
];
