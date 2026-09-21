/**
 * Inbox projection.
 *
 * The inbox lives on `threads` rather than in a table of its own, so what
 * needs testing is that the projection columns stay true as a thread moves
 * through its states — and that "unread" behaves as a derived rule rather than
 * a flag someone has to remember to invalidate.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { getPool, closePool } from "../db/pool.js";
import { migrate } from "../db/migrate.js";
import * as threadsDb from "../db/threads.js";
import { inboxCounts, listInbox, markAllRead, markRead } from "../db/inbox.js";
import { AgentService } from "../services/agents.js";
import { loadConfig } from "../config.js";
import type { AgentDraft } from "@fastcar/shared";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://fastcar:fastcar@127.0.0.1:5433/fastcar";

const PUBLIC = "http://public.test";
/** Run-unique so a crashed run cannot collide with the next one. */
const RUN = Date.now().toString(36);
const draft = (name: string): AgentDraft => ({
  name,
  slug: `inbox-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${RUN}`.slice(0, 32),
  systemPrompt: "x",
  modelProvider: "inceptionlabs",
  modelSlug: "mercury-2.5",
  tools: ["read"],
});

/** Only the rows this test made — the dev database has plenty of others. */
async function mine(ids: string[], opts: Parameters<typeof listInbox>[0]) {
  const all = await listInbox(opts);
  const set = new Set(ids);
  return all.filter((i) => set.has(i.threadId));
}

test("inbox", async (t) => {
  process.env.DATABASE_URL = DATABASE_URL;
  process.env.FASTCAR_MOCK = "1";
  await migrate();
  const svc = new AgentService(loadConfig());

  const agentA = await svc.create(draft("Inbox Test A"));
  const agentB = await svc.create(draft("Inbox Test B"));
  const t1 = await threadsDb.createThread("act", "chat", null, agentA.id);
  const t2 = await threadsDb.createThread("act", "chat", null, agentB.id);
  const ids = [t1.id, t2.id];

  t.after(async () => {
    // Tolerant: a failed subtest must not leave rows behind for the next run.
    for (const id of ids) await threadsDb.deleteThread(id).catch(() => {});
    for (const a of [agentA, agentB]) {
      await getPool().query("DELETE FROM threads WHERE agent_id = $1", [a.id]).catch(() => {});
      await svc.delete(a.id).catch(() => {});
    }
    await closePool();
  });

  await t.test("a thread with no reply yet is not unread", async () => {
    const [row] = await mine([t1.id], { publicUrlBase: PUBLIC });
    assert.ok(row);
    assert.equal(row.unread, false);
    assert.equal(row.preview, "");
    assert.equal(row.agentName, "Inbox Test A");
  });

  await t.test("a reply sets the preview and marks it unread", async () => {
    await threadsDb.updateThread(t1.id, {
      lastMessageAt: new Date(),
      lastMessagePreview: "Here is your morning brief.",
      lastMessageAgent: "inbox-test-a",
    });
    const [row] = await mine([t1.id], { publicUrlBase: PUBLIC });
    assert.equal(row!.unread, true);
    assert.equal(row!.preview, "Here is your morning brief.");
  });

  await t.test("reading clears it, and a later reply re-marks it", async () => {
    await markRead(t1.id);
    assert.equal((await mine([t1.id], { publicUrlBase: PUBLIC }))[0]!.unread, false);

    // The self-healing part: read_at < last_message_at makes this automatic,
    // with nothing having to invalidate a flag.
    await new Promise((r) => setTimeout(r, 10));
    await threadsDb.updateThread(t1.id, {
      lastMessageAt: new Date(),
      lastMessagePreview: "A second reply.",
      lastMessageAgent: "inbox-test-a",
    });
    assert.equal((await mine([t1.id], { publicUrlBase: PUBLIC }))[0]!.unread, true);
  });

  await t.test("counts partition by agent", async () => {
    await threadsDb.updateThread(t2.id, {
      lastMessageAt: new Date(),
      lastMessagePreview: "B replied.",
      lastMessageAgent: "inbox-test-b",
    });
    const { unreadByAgent, totalUnread } = await inboxCounts();
    assert.equal(unreadByAgent[agentA.id], 1);
    assert.equal(unreadByAgent[agentB.id], 1);
    assert.ok(totalUnread >= 2);
  });

  await t.test("awaiting_input surfaces as needsYou", async () => {
    await threadsDb.updateThread(t2.id, { status: "awaiting_input" });
    const [row] = await mine([t2.id], { publicUrlBase: PUBLIC });
    assert.equal(row!.needsYou, true);
    const needsYou = await mine(ids, { filter: "needs_you", publicUrlBase: PUBLIC });
    assert.deepEqual(needsYou.map((r) => r.threadId), [t2.id]);
    await threadsDb.updateThread(t2.id, { status: "idle" });
  });

  await t.test("an error is carried on the row", async () => {
    await threadsDb.updateThread(t1.id, { lastError: "LLM generation failed: boom" });
    assert.match((await mine([t1.id], { publicUrlBase: PUBLIC }))[0]!.error!, /boom/);
    await threadsDb.updateThread(t1.id, { lastError: null });
  });

  await t.test("filters and the agent scope work", async () => {
    const forA = await mine(ids, { agentId: agentA.id, publicUrlBase: PUBLIC });
    assert.deepEqual(forA.map((r) => r.threadId), [t1.id]);
    const unread = await mine(ids, { filter: "unread", publicUrlBase: PUBLIC });
    assert.equal(unread.length, 2);
  });

  await t.test("mark-all-read is scopable to one agent", async () => {
    await markAllRead(agentA.id);
    const rows = await mine(ids, { publicUrlBase: PUBLIC });
    assert.equal(rows.find((r) => r.threadId === t1.id)!.unread, false);
    assert.equal(rows.find((r) => r.threadId === t2.id)!.unread, true);
    await markAllRead();
    assert.equal(
      (await mine(ids, { publicUrlBase: PUBLIC })).every((r) => !r.unread),
      true,
    );
  });

  await t.test("a scheduled thread is a chat thread with source=schedule", async () => {
    // thread_type stays CHECK-constrained to chat|prompt; source carries the
    // distinction, which is what keeps promptThread.test.ts's assertion valid.
    const sched = await threadsDb.createThread("act", "chat", null, agentA.id, {
      source: "schedule",
      title: "Morning brief — 2026-09-20",
    });
    ids.push(sched.id);
    assert.equal(sched.threadType, "chat");
    assert.equal(sched.source, "schedule");
    assert.equal(sched.title, "Morning brief — 2026-09-20");
    const [row] = await mine([sched.id], { publicUrlBase: PUBLIC });
    assert.equal(row!.source, "schedule");
  });

  await t.test("deleting a thread takes its inbox row with it", async () => {
    const tmp = await threadsDb.createThread("act", "chat", null, agentA.id);
    await threadsDb.updateThread(tmp.id, {
      lastMessageAt: new Date(),
      lastMessagePreview: "doomed",
    });
    assert.equal((await mine([tmp.id], { publicUrlBase: PUBLIC })).length, 1);
    await threadsDb.deleteThread(tmp.id);
    assert.equal((await mine([tmp.id], { publicUrlBase: PUBLIC })).length, 0);
  });

  await t.test("artifacts ride along for a one-click open", async () => {
    const { rows } = await getPool().query<{ id: string }>(
      `INSERT INTO artifacts (thread_id, name, content_type, size, storage_path)
       VALUES ($1, 'brief.html', 'text/html', 10, 'x') RETURNING id`,
      [t1.id],
    );
    const [row] = await mine([t1.id], { publicUrlBase: PUBLIC });
    assert.equal(row!.artifacts.length, 1);
    assert.equal(row!.artifacts[0]!.name, "brief.html");
    assert.equal(row!.artifacts[0]!.url, `${PUBLIC}/artifacts/${rows[0]!.id}/brief.html`);
  });
});
