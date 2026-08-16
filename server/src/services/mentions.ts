/**
 * Backing store for the composer's `@` menu.
 *
 * Mentionable things are subagents (from agents.yaml), registered repositories,
 * and the files/directories inside them. The index is built from `git ls-files`
 * where possible (fast, honours .gitignore) and cached briefly — the menu is
 * queried on every keystroke.
 */
import fs from "node:fs";
import path from "node:path";
import type { MentionItem } from "@fastcar/shared";
import type { Config } from "../config.js";
import { listRepos, type RepoRecord } from "../db/repos.js";
import { listAgents } from "../pi/agentsConfig.js";
import { gitEvents, runGit } from "./git.js";

const CACHE_TTL_MS = 15_000;
const MAX_ENTRIES_PER_ROOT = 20_000;
const MAX_WALK_DEPTH = 10;
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".venv",
  "venv",
  "__pycache__",
  ".mypy_cache",
  ".pytest_cache",
  ".turbo",
  ".cache",
]);

interface IndexEntry {
  /** What the user types after "@" — repo-prefixed for repository files. */
  value: string;
  abs: string;
  kind: "file" | "dir";
}

interface Root {
  /** Prefix prepended to every path under this root ("" for the workdir). */
  prefix: string;
  dir: string;
  /** Absolute path that this root must not descend into (the repos dir). */
  exclude?: string;
}

let cache: { at: number; entries: IndexEntry[] } | null = null;
let inflight: Promise<IndexEntry[]> | null = null;

// Cloning or removing a repo changes what is mentionable.
gitEvents.on("changed", () => {
  cache = null;
});

// ---------------------------------------------------------------- index build

async function listRootFiles(root: Root): Promise<string[]> {
  try {
    const { stdout } = await runGit(["ls-files", "-co", "--exclude-standard", "-z"], root.dir);
    const files = stdout.split("\0").filter(Boolean);
    if (files.length) return files;
  } catch {
    // Not a git repository (or git failed) — fall back to a bounded walk.
  }
  return walk(root.dir);
}

/** Depth- and count-bounded directory walk, skipping the usual noise. */
function walk(dir: string): string[] {
  const out: string[] = [];
  const queue: Array<{ abs: string; rel: string; depth: number }> = [{ abs: dir, rel: "", depth: 0 }];
  while (queue.length && out.length < MAX_ENTRIES_PER_ROOT) {
    const { abs, rel, depth } = queue.shift()!;
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const dirent of dirents) {
      if (dirent.name.startsWith(".") || SKIP_DIRS.has(dirent.name)) continue;
      const childRel = rel ? `${rel}/${dirent.name}` : dirent.name;
      if (dirent.isDirectory()) {
        if (depth < MAX_WALK_DEPTH) {
          queue.push({ abs: path.join(abs, dirent.name), rel: childRel, depth: depth + 1 });
        }
      } else if (dirent.isFile()) {
        out.push(childRel);
        if (out.length >= MAX_ENTRIES_PER_ROOT) break;
      }
    }
  }
  return out;
}

async function buildIndex(cfg: Config, repos: RepoRecord[]): Promise<IndexEntry[]> {
  const roots: Root[] = repos
    .filter((r) => fs.existsSync(r.path))
    .map((r) => ({ prefix: `${r.name}/`, dir: r.path }));
  // The workdir is indexed too (unprefixed) so mentions work before any repo is
  // registered; anything under the repos dir is already covered above.
  if (fs.existsSync(cfg.workdir)) {
    roots.push({ prefix: "", dir: cfg.workdir, exclude: cfg.reposDir });
  }

  const entries: IndexEntry[] = [];
  const seen = new Set<string>();
  const push = (value: string, abs: string, kind: IndexEntry["kind"]) => {
    if (seen.has(value)) return;
    seen.add(value);
    entries.push({ value, abs, kind });
  };

  for (const root of roots) {
    const files = await listRootFiles(root);
    for (const rel of files) {
      const abs = path.join(root.dir, rel);
      if (root.exclude && !path.relative(root.exclude, abs).startsWith("..")) continue;
      push(`${root.prefix}${rel}`, abs, "file");
      // Directories are mentionable too — derive them from the file paths.
      let slash = rel.lastIndexOf("/");
      while (slash > 0) {
        const dirRel = rel.slice(0, slash);
        push(`${root.prefix}${dirRel}`, path.join(root.dir, dirRel), "dir");
        slash = dirRel.lastIndexOf("/");
      }
    }
  }
  return entries;
}

async function getIndex(cfg: Config, repos: RepoRecord[]): Promise<IndexEntry[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.entries;
  inflight ??= buildIndex(cfg, repos)
    .then((entries) => {
      cache = { at: Date.now(), entries };
      return entries;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

// ---------------------------------------------------------------- matching

/**
 * Subsequence match with bonuses for consecutive runs, segment starts, and
 * basename hits. Returns null when `query` is not a subsequence of `candidate`.
 */
export function fuzzyScore(query: string, candidate: string): number | null {
  if (!query) return 0;
  const q = query.toLowerCase();
  const c = candidate.toLowerCase();

  let score = 0;
  let from = 0;
  let prev = -2;
  for (const ch of q) {
    const at = c.indexOf(ch, from);
    if (at === -1) return null;
    if (at === prev + 1) score += 8;
    if (at === 0 || "/-_. ".includes(c[at - 1]!)) score += 6;
    prev = at;
    from = at + 1;
  }

  const base = c.slice(c.lastIndexOf("/") + 1);
  if (base.startsWith(q)) score += 30;
  else if (base.includes(q)) score += 18;
  else if (c.includes(q)) score += 10;
  return score - candidate.length * 0.15;
}

const KIND_RANK: Record<MentionItem["kind"], number> = { agent: 3, repo: 2, dir: 1, file: 0 };

/** Rank every mentionable thing against `query` for the composer menu. */
export async function searchMentions(
  cfg: Config,
  query: string,
  limit = 20,
): Promise<MentionItem[]> {
  const q = query.trim();
  const repos = await listRepos();
  const scored: Array<{ item: MentionItem; score: number }> = [];

  const consider = (item: MentionItem, bonus = 0) => {
    const score = fuzzyScore(q, item.value);
    if (score === null) return;
    scored.push({ item, score: score + bonus });
  };

  for (const agent of listAgents()) {
    consider({ kind: "agent", value: agent.name, label: agent.name, detail: agent.description });
  }
  for (const repo of repos) {
    consider({
      kind: "repo",
      value: repo.name,
      label: repo.name,
      detail: repo.defaultBranch ? `${repo.path} · ${repo.defaultBranch}` : repo.path,
    });
  }
  for (const entry of await getIndex(cfg, repos)) {
    consider(
      {
        kind: entry.kind,
        value: entry.value,
        label: entry.value.slice(entry.value.lastIndexOf("/") + 1),
        detail: entry.value,
      },
      // Without a query the menu should lead with shallow, obvious paths.
      q ? 0 : -entry.value.split("/").length,
    );
  }

  scored.sort(
    (a, b) =>
      b.score - a.score ||
      KIND_RANK[b.item.kind] - KIND_RANK[a.item.kind] ||
      a.item.value.length - b.item.value.length ||
      a.item.value.localeCompare(b.item.value),
  );
  return scored.slice(0, limit).map((s) => s.item);
}

// ---------------------------------------------------------------- expansion

/** `@token` at the start of the text or after whitespace, minus trailing punctuation. */
const MENTION_RE = /(?:^|\s)@([^\s@]+)/g;

export function parseMentions(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(MENTION_RE)) {
    const token = match[1]!.replace(/[.,;:!?)\]}]+$/, "");
    if (token && !out.includes(token)) out.push(token);
  }
  return out;
}

function containedPath(root: string, rel: string): string | null {
  const abs = path.resolve(root, rel);
  const inside = path.relative(root, abs);
  if (inside.startsWith("..") || path.isAbsolute(inside)) return null;
  return abs;
}

function describePath(abs: string): string | null {
  try {
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) return `directory \`${abs}\``;
    if (stat.isFile()) return `file \`${abs}\``;
  } catch {
    // does not exist
  }
  return null;
}

async function resolveMention(cfg: Config, token: string, repos: RepoRecord[]): Promise<string | null> {
  const agent = listAgents().find((a) => a.name.toLowerCase() === token.toLowerCase());
  if (agent) {
    return `subagent **${agent.name}** — ${agent.description || "delegate to it with run_subagent"}`;
  }

  const repo = repos.find((r) => r.name === token);
  if (repo) {
    return `repository **${repo.name}** at \`${repo.path}\`${repo.defaultBranch ? ` (default branch ${repo.defaultBranch})` : ""}`;
  }

  const slash = token.indexOf("/");
  if (slash > 0) {
    const owner = repos.find((r) => r.name === token.slice(0, slash));
    if (owner) {
      const abs = containedPath(owner.path, token.slice(slash + 1));
      const described = abs ? describePath(abs) : null;
      if (described) return described;
    }
  }

  const abs = containedPath(cfg.workdir, token);
  return abs ? describePath(abs) : null;
}

/**
 * Resolve the `@…` tokens in a user message into a context block appended to
 * what the conductor receives. The message shown in the transcript keeps the
 * mentions as typed; only the model sees the resolved paths. File *contents*
 * are never inlined — the agent reads what it needs.
 */
export async function expandMentions(cfg: Config, text: string): Promise<string> {
  const tokens = parseMentions(text);
  if (!tokens.length) return text;

  const repos = await listRepos();
  const lines: string[] = [];
  for (const token of tokens) {
    const resolved = await resolveMention(cfg, token, repos);
    if (resolved) lines.push(`- @${token} → ${resolved}`);
  }
  if (!lines.length) return text;
  return `${text}\n\n[References the user mentioned]\n${lines.join("\n")}`;
}
