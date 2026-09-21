/**
 * Agent registry: seeding, code-default resolution, validation and the
 * deletion refusal.
 *
 * The interesting property under test is that a builtin's null columns mean
 * "resolve from code" rather than "unset" — that is what keeps INCEPTION_MODEL,
 * CONDUCTOR_REASONING_EFFORT and edits to CONDUCTOR_BASE taking effect after
 * the migration.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../config.js";
import { getPool, closePool } from "../db/pool.js";
import { migrate } from "../db/migrate.js";
import * as threadsDb from "../db/threads.js";
import { AgentService, AgentValidationError } from "../services/agents.js";
import { CONDUCTOR_DEFAULT_TOOLS } from "../tools/registry.js";
import type { AgentDraft } from "@fastcar/shared";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://fastcar:fastcar@127.0.0.1:5433/fastcar";

/** Run-unique so a crashed run (or a dev database) cannot collide. */
const RUN = Date.now().toString(36);
const draft = (over: Partial<AgentDraft> = {}): AgentDraft => ({
  name: `News Desk ${RUN}`,
  systemPrompt: "You curate a daily news brief.",
  modelProvider: "inceptionlabs",
  modelSlug: "mercury-2.5",
  tools: ["read", "web_search", "create_artifact"],
  ...over,
});

test("agents", async (t) => {
  process.env.DATABASE_URL = DATABASE_URL;
  process.env.FASTCAR_MOCK = "1";
  const cfg = loadConfig();
  await migrate();
  const svc = new AgentService(cfg);
  const created: string[] = [];

  t.after(async () => {
    for (const id of created) {
      await getPool().query("DELETE FROM threads WHERE agent_id = $1", [id]).catch(() => {});
      await getPool().query("DELETE FROM agents WHERE id = $1", [id]).catch(() => {});
    }
    await closePool();
  });

  await t.test("the builtin conductor is seeded with code defaults", async () => {
    const rec = await svc.builtin();
    assert.equal(rec.slug, "conductor");
    assert.equal(rec.isBuiltin, true);
    // Null means "from code", not "unset".
    assert.equal(rec.systemPrompt, null);
    assert.equal(rec.modelSlug, null);
    assert.equal(rec.tools, null);

    const r = svc.resolve(rec);
    assert.equal(r.modelProvider, "inceptionlabs");
    assert.equal(r.modelSlug, cfg.inceptionModel, "follows INCEPTION_MODEL, not a frozen literal");
    assert.equal(r.reasoningEffort, cfg.conductorReasoningEffort);
    assert.deepEqual(r.tools, [...CONDUCTOR_DEFAULT_TOOLS]);
  });

  await t.test("threads that predate the agents table were backfilled", async () => {
    // Scoped to threads older than the builtin row. A thread created *after*
    // the migration may legitimately have a null agent_id — createThread(mode)
    // with no agent leaves it null and resolves to the builtin at runtime,
    // which is what addRepo() and the prompt-thread tests rely on.
    const { rows } = await getPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM threads t
       WHERE t.agent_id IS NULL
         AND t.created_at < (SELECT created_at FROM agents WHERE slug = 'conductor')`,
    );
    assert.equal(Number(rows[0]!.n), 0);
  });

  await t.test("an unowned thread still resolves to the builtin", async () => {
    const r = await svc.forThread(null);
    assert.equal(r.slug, "conductor");
  });

  await t.test("creating an agent forces ask_user and submit_plan on", async () => {
    const rec = await svc.create(draft());
    created.push(rec.id);
    assert.ok(rec.tools!.includes("ask_user"), "an agent must be able to pause for the user");
    assert.ok(rec.tools!.includes("submit_plan"), "plan mode dead-ends without it");
    assert.match(rec.slug, /^news-desk-/, "slug derived from the name");
    assert.deepEqual(svc.resolve(rec).tools, rec.tools);
  });

  await t.test("submit_plan is omitted when the agent has no plan mode", async () => {
    const rec = await svc.create(draft({ name: "No Plan", supportsPlanMode: false }));
    created.push(rec.id);
    assert.ok(rec.tools!.includes("ask_user"));
    assert.ok(!rec.tools!.includes("submit_plan"));
  });

  await t.test("a per-agent reasoning effort overrides the global setting", async () => {
    const rec = await svc.create(draft({ name: "Pinned", reasoningEffort: "high" }));
    created.push(rec.id);
    assert.equal(svc.resolve(rec).reasoningEffort, "high");
    const unpinned = await svc.create(draft({ name: "Unpinned" }));
    created.push(unpinned.id);
    assert.equal(svc.resolve(unpinned).reasoningEffort, cfg.conductorReasoningEffort);
  });

  await t.test("validation rejects bad input", async () => {
    await assert.rejects(
      () => svc.create(draft({ name: "Bad tools", tools: ["read", "nope"] })),
      (e: Error) => e instanceof AgentValidationError && /unknown tool/.test(e.message),
    );
    await assert.rejects(
      () => svc.create(draft({ name: "Bad slug", slug: "Not A Slug" })),
      (e: Error) => e instanceof AgentValidationError && /slug must be/.test(e.message),
    );
    await assert.rejects(
      () => svc.create(draft({ name: "Reserved", slug: "maxcoding" })),
      (e: Error) => e instanceof AgentValidationError && /delegation subagent/.test(e.message),
    );
    const first = await svc.create(draft({ name: `Dup ${RUN}`, slug: `dup-${RUN}`.slice(0, 32) }));
    created.push(first.id);
    await assert.rejects(
      () => svc.create(draft({ name: "Dup again", slug: first.slug })),
      (e: Error) => e instanceof AgentValidationError && /already exists/.test(e.message),
    );
  });

  await t.test("the builtin's code-backed fields cannot be edited", async () => {
    const b = await svc.builtin();
    await assert.rejects(
      () => svc.update(b.id, { systemPrompt: "hijacked" }),
      (e: Error) => e instanceof AgentValidationError && /come from code/.test(e.message),
    );
    // Presentation is still editable — restore it so the row is left as seeded.
    const original = b.description;
    const renamed = await svc.update(b.id, { description: "still the orchestrator" });
    assert.equal(renamed.description, "still the orchestrator");
    await svc.update(b.id, { description: original });
  });

  await t.test("the builtin cannot be deleted", async () => {
    const b = await svc.builtin();
    await assert.rejects(
      () => svc.delete(b.id),
      (e: Error) => e instanceof AgentValidationError && /cannot be deleted/.test(e.message),
    );
  });

  await t.test("an agent that still owns threads is refused, not orphaned", async () => {
    const rec = await svc.create(draft({ name: "Owns Threads" }));
    created.push(rec.id);
    const thread = await threadsDb.createThread("act", "chat", null, rec.id);
    await assert.rejects(
      () => svc.delete(rec.id),
      (e: Error) => e instanceof AgentValidationError && /still owns 1 thread/.test(e.message),
    );
    // Archiving is the offered way out, and it leaves the threads alone.
    const archived = await svc.archive(rec.id);
    assert.equal(archived.archived, true);
    assert.equal((await threadsDb.getThread(thread.id))?.agentId, rec.id);

    await threadsDb.deleteThread(thread.id);
    await svc.delete(rec.id);
    assert.equal(await svc.get(rec.id), null);
  });

  await t.test("threads carry their agent through create and list", async () => {
    const rec = await svc.create(draft({ name: "Lister" }));
    created.push(rec.id);
    const thread = await threadsDb.createThread("act", "chat", null, rec.id);
    const mine = await threadsDb.listThreads({ agentId: rec.id });
    assert.deepEqual(mine.map((x) => x.id), [thread.id]);
    assert.equal(mine[0]!.agentId, rec.id);
    await threadsDb.deleteThread(thread.id);
  });
});
