/**
 * Repo adoption: a checkout an agent made with raw `git clone` (no git_clone,
 * so no registry row) is registered on the next sweep, so the sidebar and the
 * `@` menu — both registry-backed — show it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../config.js";
import { closePool } from "../db/pool.js";
import { migrate } from "../db/migrate.js";
import { deleteRepo, getRepoByName } from "../db/repos.js";
import { adoptUnregisteredRepos, gitEvents, runGit } from "../services/git.js";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://fastcar:fastcar@127.0.0.1:5433/fastcar";

/** Run-unique so a crashed run (or a dev database) cannot collide. */
const RUN = Date.now().toString(36);

test("repo adoption", async (t) => {
  process.env.DATABASE_URL = DATABASE_URL;
  process.env.FASTCAR_MOCK = "1";
  await migrate();
  const reposDir = fs.mkdtempSync(path.join(os.tmpdir(), "fastcar-adopt-"));
  const cfg = { ...loadConfig(), reposDir };
  const name = `adopt-${RUN}`;

  t.after(async () => {
    await deleteRepo(name).catch(() => {});
    fs.rmSync(reposDir, { recursive: true, force: true });
    await closePool();
  });

  // What a bash `git clone` leaves behind: a checkout with an origin remote.
  const dir = path.join(reposDir, name);
  fs.mkdirSync(dir);
  await runGit(["init", "-q", "-b", "main"], dir);
  await runGit(
    ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"],
    dir,
  );
  await runGit(["remote", "add", "origin", "https://example.com/acme/widget.git"], dir);
  // Not a checkout: must be left alone.
  fs.mkdirSync(path.join(reposDir, `plain-${RUN}`));

  await t.test("registers an unregistered checkout and announces it", async () => {
    let changed = 0;
    const onChanged = () => changed++;
    gitEvents.on("changed", onChanged);
    try {
      assert.deepEqual(await adoptUnregisteredRepos(cfg), [name]);
    } finally {
      gitEvents.off("changed", onChanged);
    }
    assert.equal(changed, 1, "the sidebar refresh rides gitEvents");
    const rec = await getRepoByName(name);
    assert.equal(rec?.url, "https://example.com/acme/widget.git");
    assert.equal(rec?.path, dir);
    assert.equal(rec?.defaultBranch, "main");
    assert.equal(await getRepoByName(`plain-${RUN}`), null);
  });

  await t.test("a second sweep is a quiet no-op", async () => {
    let changed = 0;
    const onChanged = () => changed++;
    gitEvents.on("changed", onChanged);
    try {
      assert.deepEqual(await adoptUnregisteredRepos(cfg), []);
    } finally {
      gitEvents.off("changed", onChanged);
    }
    assert.equal(changed, 0);
  });
});
