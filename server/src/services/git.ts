import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import type { RepoStatus } from "@fastcar/shared";
import type { Config } from "../config.js";
import { deleteRepo, getRepoByName, listRepos, registerRepo, type RepoRecord } from "../db/repos.js";

/** Emits "changed" whenever the set of repos (or their state) may have changed. */
export const gitEvents = new EventEmitter();

const EXEC_TIMEOUT_MS = 10 * 60 * 1000;

export function runGit(
  args: string[],
  cwd: string | undefined,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        cwd,
        timeout: EXEC_TIMEOUT_MS,
        maxBuffer: 10 * 1024 * 1024,
        signal,
        env: {
          ...process.env,
          // Never hang on interactive credential prompts inside the VM.
          GIT_TERMINAL_PROMPT: "0",
          GIT_ASKPASS: "true",
        },
      },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`git ${args.join(" ")} failed: ${stderr || err.message}`.trim()));
        } else {
          resolve({ stdout, stderr });
        }
      },
    );
  });
}

/** `-c user.name/email` args when the VM has no global git identity configured. */
function identityArgs(cfg: Config): string[] {
  const args: string[] = [];
  if (cfg.gitName) args.push("-c", `user.name=${cfg.gitName}`);
  if (cfg.gitEmail) args.push("-c", `user.email=${cfg.gitEmail}`);
  return args;
}

/**
 * Keep `.codegraph/` out of the repository's own git status.
 *
 * The index lives at the indexed root, so without this every cloned repo reads
 * as dirty: the UI shows a permanent uncommitted-changes dot, purge refuses,
 * and `git_commit` with addAll would commit our index into the user's project.
 * `.git/info/exclude` is the local-only ignore list — the repository's tracked
 * .gitignore is theirs and stays untouched.
 */
function excludeIndexFromGit(dir: string): void {
  try {
    if (!fs.existsSync(path.join(dir, ".git"))) return;
    const infoDir = path.join(dir, ".git", "info");
    fs.mkdirSync(infoDir, { recursive: true });
    const file = path.join(infoDir, "exclude");
    const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    if (/^\.codegraph\/?$/m.test(current)) return;
    const prefix = !current || current.endsWith("\n") ? "" : "\n";
    fs.appendFileSync(file, `${prefix}.codegraph/\n`);
  } catch (err) {
    console.error(`failed to exclude .codegraph in ${dir}:`, err);
  }
}

/**
 * Refresh the repository's codegraph symbol index (see deploy/image/Dockerfile).
 *
 * Best-effort by design: the binary ships in the VM image but is not required —
 * on a dev box without it, execFile fails with ENOENT and the agents simply fall
 * back to grep. Bounded so a pathological repo cannot stall a git operation.
 */
function reindexForSearch(dir: string): Promise<void> {
  excludeIndexFromGit(dir);
  return new Promise((resolve) => {
    execFile("codegraph", ["index", dir], { timeout: 60_000, cwd: dir }, (err) => {
      if (err && (err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error(`codegraph index failed for ${dir}:`, err.message);
      }
      resolve();
    });
  });
}

export function deriveRepoName(url: string): string {
  const base = url.replace(/\/+$/, "").split("/").pop() ?? "repo";
  return base.replace(/\.git$/, "").replace(/[^a-zA-Z0-9._-]/g, "-") || "repo";
}

export async function resolveRepo(name: string): Promise<RepoRecord> {
  const repo = await getRepoByName(name);
  if (!repo) {
    const names = (await listRepos()).map((r) => r.name);
    throw new Error(
      `No registered repository named "${name}". Registered: ${names.join(", ") || "(none)"}`,
    );
  }
  if (!fs.existsSync(repo.path)) {
    throw new Error(`Repository "${name}" is registered but missing on disk at ${repo.path}`);
  }
  return repo;
}

export async function cloneRepo(
  cfg: Config,
  url: string,
  name: string | undefined,
  signal?: AbortSignal,
): Promise<RepoRecord> {
  const repoName = name?.trim() || deriveRepoName(url);
  const dest = path.join(cfg.reposDir, repoName);
  if (fs.existsSync(dest)) {
    throw new Error(`Destination already exists: ${dest}. Pick a different name.`);
  }
  fs.mkdirSync(cfg.reposDir, { recursive: true });
  await runGit(["clone", url, dest], undefined, signal);
  const branch = (await runGit(["rev-parse", "--abbrev-ref", "HEAD"], dest)).stdout.trim();
  const record = await registerRepo(repoName, url, dest, branch || null);
  // Index at clone time so the first search an agent runs already works.
  await reindexForSearch(dest);
  gitEvents.emit("changed");
  return record;
}

export async function pullRepo(name: string, signal?: AbortSignal): Promise<string> {
  const repo = await resolveRepo(name);
  const { stdout, stderr } = await runGit(["pull", "--ff-only"], repo.path, signal);
  await reindexForSearch(repo.path);
  gitEvents.emit("changed");
  return (stdout + stderr).trim();
}

export async function checkoutBranch(
  name: string,
  branch: string,
  create: boolean,
  signal?: AbortSignal,
): Promise<string> {
  const repo = await resolveRepo(name);
  const args = create ? ["checkout", "-b", branch] : ["checkout", branch];
  const { stdout, stderr } = await runGit(args, repo.path, signal);
  // A checkout can rewrite the whole tree; re-indexing is incremental (ms).
  await reindexForSearch(repo.path);
  gitEvents.emit("changed");
  return (stdout + stderr).trim();
}

export async function commitRepo(
  cfg: Config,
  name: string,
  message: string,
  addAll: boolean,
  signal?: AbortSignal,
): Promise<string> {
  const repo = await resolveRepo(name);
  if (addAll) await runGit(["add", "-A"], repo.path, signal);
  const { stdout } = await runGit(
    [...identityArgs(cfg), "commit", "-m", message],
    repo.path,
    signal,
  );
  gitEvents.emit("changed");
  return stdout.trim();
}

export async function pushRepo(name: string, signal?: AbortSignal): Promise<string> {
  const repo = await resolveRepo(name);
  const branch = (await runGit(["rev-parse", "--abbrev-ref", "HEAD"], repo.path)).stdout.trim();
  // -u handles both first push of a new branch and subsequent pushes.
  const { stdout, stderr } = await runGit(["push", "-u", "origin", branch], repo.path, signal);
  gitEvents.emit("changed");
  return (stdout + stderr).trim() || `pushed ${branch}`;
}

// ---------------------------------------------------------------- purging

/** Thrown when a repository still holds work that a purge would destroy. */
export class PurgeRefusedError extends Error {
  constructor(
    readonly repoName: string,
    readonly reasons: string[],
  ) {
    super(
      `Refusing to purge "${repoName}": ${reasons.join("; ")}. Purge with force to delete it anyway.`,
    );
    this.name = "PurgeRefusedError";
  }
}

export interface PurgeResult {
  name: string;
  path: string;
  /** The registry entry was dropped but no files were deleted. */
  registryOnly: boolean;
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** Work that would be lost with the clone — empty means the purge is safe. */
async function unsavedWork(dir: string): Promise<string[]> {
  const reasons: string[] = [];
  try {
    const porcelain = (await runGit(["status", "--porcelain"], dir)).stdout.trim();
    if (porcelain) reasons.push(`${porcelain.split("\n").length} uncommitted change(s)`);
  } catch {
    // A checkout git cannot read is one we cannot clear — let force decide.
    return ["its git state could not be read"];
  }
  try {
    // Commits reachable from a local branch but from no remote-tracking branch.
    // With no remote configured that is every commit, which is the honest answer.
    const unpushed = (await runGit(["log", "--branches", "--not", "--remotes", "--oneline"], dir))
      .stdout.trim();
    if (unpushed) reasons.push(`${unpushed.split("\n").length} commit(s) on no remote`);
  } catch {
    // no branches yet
  }
  return reasons;
}

/**
 * Deregister a repository and delete its clone.
 *
 * Refuses when the clone holds uncommitted changes or commits that exist on no
 * remote, unless `force`. Files are only ever deleted from inside the managed
 * repos directory: a repository registered from elsewhere is deregistered and
 * left on disk.
 */
export async function purgeRepo(
  cfg: Config,
  name: string,
  opts: { force?: boolean } = {},
): Promise<PurgeResult> {
  const repo = await getRepoByName(name);
  if (!repo) {
    const names = (await listRepos()).map((r) => r.name);
    throw new Error(
      `No registered repository named "${name}". Registered: ${names.join(", ") || "(none)"}`,
    );
  }

  const managed = isInside(cfg.reposDir, repo.path);
  const onDisk = fs.existsSync(repo.path);
  let registryOnly = true;

  if (onDisk && managed) {
    if (!opts.force) {
      const reasons = await unsavedWork(repo.path);
      if (reasons.length) throw new PurgeRefusedError(name, reasons);
    }
    await fs.promises.rm(repo.path, { recursive: true, force: true });
    registryOnly = false;
  }

  await deleteRepo(name);
  gitEvents.emit("changed");
  return { name, path: repo.path, registryOnly };
}

export async function repoStatusText(name: string): Promise<string> {
  const repo = await resolveRepo(name);
  const status = (await runGit(["status", "--short", "--branch"], repo.path)).stdout.trim();
  const log = (
    await runGit(["log", "--oneline", "-5"], repo.path).catch(() => ({ stdout: "" }))
  ).stdout.trim();
  return `${status}\n\nRecent commits:\n${log}`;
}

/** Live status for the UI repo panel; tolerant of broken checkouts. */
export async function collectRepoStatuses(): Promise<RepoStatus[]> {
  const repos = await listRepos();
  return Promise.all(
    repos.map(async (repo): Promise<RepoStatus> => {
      const base = { name: repo.name, url: repo.url, path: repo.path };
      if (!fs.existsSync(repo.path)) return { ...base, branch: null, dirty: false, missing: true };
      try {
        const branch = (
          await runGit(["rev-parse", "--abbrev-ref", "HEAD"], repo.path)
        ).stdout.trim();
        const porcelain = (await runGit(["status", "--porcelain"], repo.path)).stdout;
        const lastCommitAt =
          (await runGit(["log", "-1", "--format=%cI"], repo.path).catch(() => ({ stdout: "" })))
            .stdout.trim() || undefined;
        let ahead = 0;
        let behind = 0;
        try {
          const counts = (
            await runGit(["rev-list", "--left-right", "--count", "@{upstream}...HEAD"], repo.path)
          ).stdout.trim();
          const [b, a] = counts.split(/\s+/).map(Number);
          behind = b ?? 0;
          ahead = a ?? 0;
        } catch {
          // no upstream configured
        }
        return {
          ...base,
          branch,
          dirty: porcelain.trim().length > 0,
          ahead,
          behind,
          missing: false,
          lastCommitAt,
        };
      } catch {
        return { ...base, branch: null, dirty: false, missing: false };
      }
    }),
  );
}
