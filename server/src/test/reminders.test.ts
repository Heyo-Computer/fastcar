/**
 * Reminders: due-time parsing, the claim that prevents double-fires, and the
 * sweep's handling of busy threads, failures and boot recovery.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { getPool, closePool } from "../db/pool.js";
import { migrate } from "../db/migrate.js";
import * as remindersDb from "../db/reminders.js";
import * as threadsDb from "../db/threads.js";
import { relative, resolveDueAt } from "../tools/reminders.js";
import { ReminderService, type ReminderTarget } from "../services/reminders.js";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://fastcar:fastcar@127.0.0.1:5433/fastcar";

test("due-time parsing", async (t) => {
  const now = new Date("2026-10-01T12:00:00Z");

  await t.test("delay_minutes counts from now", () => {
    assert.equal(resolveDueAt({ delay_minutes: 90 }, now).toISOString(), "2026-10-01T13:30:00.000Z");
  });

  await t.test("at honours its offset", () => {
    assert.equal(
      resolveDueAt({ at: "2026-10-02T09:00:00-07:00" }, now).toISOString(),
      "2026-10-02T16:00:00.000Z",
    );
  });

  await t.test("rejects bad input with a message the model can act on", () => {
    assert.throws(() => resolveDueAt({}, now), /exactly one/);
    assert.throws(() => resolveDueAt({ delay_minutes: 5, at: "2026-10-02T09:00:00Z" }, now), /exactly one/);
    assert.throws(() => resolveDueAt({ delay_minutes: 0 }, now), /positive/);
    assert.throws(() => resolveDueAt({ at: "2026-10-02T09:00:00" }, now), /timezone offset/);
    assert.throws(() => resolveDueAt({ at: "2026-09-30T09:00:00Z" }, now), /in the past/);
    assert.throws(() => resolveDueAt({ delay_minutes: 60 * 24 * 400 }, now), /a year/);
  });

  await t.test("relative reads both ways", () => {
    assert.equal(relative(new Date("2026-10-02T14:05:00Z"), now), "in 1d 2h 5m");
    assert.equal(relative(new Date("2026-10-01T11:55:00Z"), now), "5m ago");
  });
});

test("reminder sweep", async (t) => {
  process.env.DATABASE_URL = DATABASE_URL;
  await migrate();
  const thread = await threadsDb.createThread("act", "chat");

  // Created in the future and only then made due, so a dev server sweeping
  // the same database cannot grab them first.
  const mk = (message: string) =>
    remindersDb.createReminder(thread.id, message, new Date(Date.now() + 3600_000));
  const makeDue = (id: string) =>
    getPool().query("UPDATE reminders SET due_at = now() - interval '1 second' WHERE id = $1", [id]);

  t.after(async () => {
    await threadsDb.deleteThread(thread.id).catch(() => {});
    await closePool();
  });

  await t.test("only one of two concurrent claims wins", async () => {
    const r = await mk("race");
    await makeDue(r.id);
    const [a, b] = await Promise.all([
      remindersDb.claimDueReminders(),
      remindersDb.claimDueReminders(),
    ]);
    const hits = [...a, ...b].filter((x) => x.id === r.id);
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.status, "firing");
    await remindersDb.markFired(r.id);
  });

  await t.test("a due reminder is delivered to its thread and marked fired", async () => {
    const r = await mk("check the deploy");
    const calls: Array<[string, string]> = [];
    const target: ReminderTarget = {
      deliverReminder: async (threadId, text) => {
        calls.push([threadId, text]);
        return "delivered";
      },
    };
    await makeDue(r.id);
    await new ReminderService(target).sweep();
    const mine = calls.filter(([id]) => id === thread.id);
    assert.equal(mine.length, 1);
    assert.match(mine[0]![1], /⏰ Reminder .*check the deploy/);
    const after = await remindersDb.getReminder(r.id);
    assert.equal(after?.status, "fired");
    assert.ok(after?.firedAt);
  });

  await t.test("a busy thread hands the reminder back for the next sweep", async () => {
    const r = await mk("busy");
    await makeDue(r.id);
    await new ReminderService({ deliverReminder: async () => "busy" }).sweep();
    const after = await remindersDb.getReminder(r.id);
    assert.equal(after?.status, "pending");
    assert.equal(after?.attempts, 1);
    await remindersDb.cancelReminder(r.id, thread.id);
  });

  await t.test("a delivery failure is recorded, not retried forever", async () => {
    const r = await mk("boom");
    await makeDue(r.id);
    await new ReminderService({
      deliverReminder: async () => {
        throw new Error("conductor exploded");
      },
    }).sweep();
    const after = await remindersDb.getReminder(r.id);
    assert.equal(after?.status, "error");
    assert.equal(after?.lastError, "conductor exploded");
  });

  await t.test("cancel is scoped to the owning thread", async () => {
    const r = await mk("scoped");
    const other = await threadsDb.createThread("act", "chat");
    try {
      assert.equal(await remindersDb.cancelReminder(r.id, other.id), false);
      assert.equal(await remindersDb.cancelReminder(r.id, thread.id), true);
      assert.equal((await remindersDb.listReminders(thread.id)).some((x) => x.id === r.id), false);
      assert.equal((await remindersDb.listReminders(thread.id, true)).some((x) => x.id === r.id), true);
    } finally {
      await threadsDb.deleteThread(other.id);
    }
  });

  await t.test("boot recovery returns rows stuck mid-delivery to pending", async () => {
    const r = await mk("stuck");
    await getPool().query("UPDATE reminders SET status = 'firing' WHERE id = $1", [r.id]);
    assert.ok((await remindersDb.resetFiringReminders()) >= 1);
    assert.equal((await remindersDb.getReminder(r.id))?.status, "pending");
  });

  await t.test("deleting the thread deletes its reminders", async () => {
    const other = await threadsDb.createThread("act", "chat");
    const r = await remindersDb.createReminder(other.id, "gone", new Date(Date.now() + 60_000));
    await threadsDb.deleteThread(other.id);
    assert.equal(await remindersDb.getReminder(r.id), null);
  });
});
