/**
 * Exercises the git service (the layer the git_* tools call) against a local
 * bare repository: clone → checkout -b → commit → push → pull → status.
 *   DATABASE_URL=... npm run smoke:git --workspace=@fastcar/server
 */
process.env.FASTCAR_MOCK ??= "1";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../config.js";
import { migrate } from "../db/migrate.js";
import { closePool } from "../db/pool.js";
import { deleteRepo } from "../db/repos.js";
import {
  checkoutBranch,
  cloneRepo,
  collectRepoStatuses,
  commitRepo,
  pullRepo,
  pushRepo,
  runGit,
} from "../services/git.js";

function assert(cond: unknown, label: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${label}`);
  console.log(`ok: ${label}`);
}

const cfg = loadConfig();
await migrate();

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fastcar-git-smoke-"));
const bare = path.join(tmp, "origin.git");
const seed = path.join(tmp, "seed");
const repoName = `smoke-${Date.now()}`;

// Seed a bare origin with one commit.
await runGit(["init", "--bare", "--initial-branch=main", bare], undefined);
await runGit(["init", "--initial-branch=main", seed], undefined);
fs.writeFileSync(path.join(seed, "README.md"), "# smoke\n");
await runGit(["add", "-A"], seed);
await runGit(["-c", "user.name=smoke", "-c", "user.email=smoke@test", "commit", "-m", "init"], seed);
await runGit(["remote", "add", "origin", bare], seed);
await runGit(["push", "origin", "main"], seed);

try {
  const repo = await cloneRepo(cfg, bare, repoName);
  assert(fs.existsSync(path.join(repo.path, "README.md")), "clone materialized the working tree");
  assert(repo.defaultBranch === "main", `default branch detected (${repo.defaultBranch})`);

  await checkoutBranch(repoName, "feature/smoke", true);
  fs.writeFileSync(path.join(repo.path, "change.txt"), "hello from fastcar\n");
  const commitOut = await commitRepo(cfg, repoName, "smoke: add change.txt", true);
  assert(commitOut.includes("smoke: add change.txt"), "commit created");

  const pushOut = await pushRepo(repoName);
  assert(pushOut.length > 0, "push to origin succeeded");
  const originBranches = (await runGit(["branch"], bare)).stdout;
  assert(originBranches.includes("feature/smoke"), "origin received the new branch");

  await checkoutBranch(repoName, "main", false);
  const pullOut = await pullRepo(repoName);
  assert(pullOut.length > 0, "pull on main succeeded");

  const statuses = await collectRepoStatuses();
  const status = statuses.find((s) => s.name === repoName);
  assert(status?.branch === "main", "status reports current branch");
  assert(status?.dirty === false, "status reports clean tree");

  console.log("\nALL GIT SMOKE TESTS PASSED");
} finally {
  await deleteRepo(repoName).catch(() => {});
  fs.rmSync(tmp, { recursive: true, force: true });
  const clonePath = path.join(cfg.reposDir, repoName);
  fs.rmSync(clonePath, { recursive: true, force: true });
  await closePool();
}
