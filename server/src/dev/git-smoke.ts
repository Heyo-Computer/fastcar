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
import { getRepoByName } from "../db/repos.js";
import {
  checkoutBranch,
  cloneRepo,
  collectRepoStatuses,
  commitRepo,
  pullRepo,
  purgeRepo,
  PurgeRefusedError,
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

  // codegraph indexes at clone time. The index lives inside the checkout, so it
  // must be excluded locally — otherwise the repo reads dirty forever and
  // `git_commit` with addAll would commit it into the user's project.
  if (fs.existsSync(path.join(repo.path, ".codegraph", "index.json"))) {
    const exclude = fs.readFileSync(path.join(repo.path, ".git/info/exclude"), "utf8");
    assert(exclude.includes(".codegraph/"), "clone-time index is ignored via .git/info/exclude");
  } else {
    console.log("skip: codegraph not on PATH — clone built no index");
  }

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
  assert(status?.lastCommitAt != null, "status reports the last commit date (repo age)");

  // Purge refuses while the clone still holds work…
  fs.writeFileSync(path.join(repo.path, "scratch.txt"), "unsaved\n");
  let refused: unknown;
  await purgeRepo(cfg, repoName).catch((err) => (refused = err));
  assert(refused instanceof PurgeRefusedError, "purge refuses a repo with uncommitted changes");
  assert(fs.existsSync(repo.path), "refused purge left the clone untouched");

  await commitRepo(cfg, repoName, "smoke: scratch", true);
  refused = undefined;
  await purgeRepo(cfg, repoName).catch((err) => (refused = err));
  assert(refused instanceof PurgeRefusedError, "purge refuses a repo with commits on no remote");

  // …and goes through once the work is safe (or when forced).
  await pushRepo(repoName);
  const purged = await purgeRepo(cfg, repoName);
  assert(purged.registryOnly === false, "purge deleted the clone");
  assert(!fs.existsSync(repo.path), "clone directory is gone");
  assert((await getRepoByName(repoName)) === null, "repository is deregistered");
  assert(
    !(await collectRepoStatuses()).some((s) => s.name === repoName),
    "purged repo no longer appears in the repo panel data",
  );

  // Forcing works even with unsaved work in the tree.
  const forcedName = `${repoName}-forced`;
  const forced = await cloneRepo(cfg, bare, forcedName);
  fs.writeFileSync(path.join(forced.path, "scratch.txt"), "unsaved\n");
  await purgeRepo(cfg, forcedName, { force: true });
  assert(!fs.existsSync(forced.path), "forced purge deletes a dirty clone");

  console.log("\nALL GIT SMOKE TESTS PASSED");
} finally {
  // Idempotent cleanup: the purge assertions above may already have run.
  for (const name of [repoName, `${repoName}-forced`]) {
    await deleteRepo(name).catch(() => {});
    fs.rmSync(path.join(cfg.reposDir, name), { recursive: true, force: true });
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  await closePool();
}
