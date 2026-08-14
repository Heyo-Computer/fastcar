import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import type { RepoStatus } from "@fastcar/shared";
import type { Config } from "../config.js";
import { getRepoByName, listRepos, registerRepo, type RepoRecord } from "../db/repos.js";

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
  gitEvents.emit("changed");
  return record;
}

export async function pullRepo(name: string, signal?: AbortSignal): Promise<string> {
  const repo = await resolveRepo(name);
  const { stdout, stderr } = await runGit(["pull", "--ff-only"], repo.path, signal);
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
        return { ...base, branch, dirty: porcelain.trim().length > 0, ahead, behind, missing: false };
      } catch {
        return { ...base, branch: null, dirty: false, missing: false };
      }
    }),
  );
}
