/**
 * Schedules: cron maths (including DST), the claim that prevents double-fires
 * and overlap, and boot recovery.
 *
 * The cron cases are the point of taking croner as a dependency: "next
 * occurrence at or after T in zone Z" is where a hand-rolled scheduler goes
 * quietly wrong twice a year, and that failure is invisible without tests that
 * cross a transition deliberately.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { getPool, closePool } from "../db/pool.js";
import { migrate } from "../db/migrate.js";
import * as schedulesDb from "../db/schedules.js";
import * as threadsDb from "../db/threads.js";
import { nextRun, previewRuns, validateCron } from "../services/scheduler.js";
import { AgentService } from "../services/agents.js";
import { loadConfig } from "../config.js";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://fastcar:fastcar@127.0.0.1:5433/fastcar";
const RUN = Date.now().toString(36);

test("cron maths", async (t) => {
  await t.test("a daily job resolves in its own timezone, not the server's", () => {
    // 07:00 America/Los_Angeles is 14:00 UTC while PDT is in effect.
    const from = new Date("2026-09-20T00:00:00Z");
    const next = nextRun("0 7 * * *", "America/Los_Angeles", from)!;
    assert.equal(next.toISOString(), "2026-09-20T14:00:00.000Z");
  });

  await t.test("spring forward does not lose the run", () => {
    // 2026-03-08, America/New_York: 02:00 EST jumps to 03:00 EDT, so a 02:30
    // daily job has no 02:30 that day. It must still fire, not silently skip.
    const from = new Date("2026-03-08T00:00:00-05:00");
    const next = nextRun("30 2 * * *", "America/New_York", from)!;
    assert.equal(next.toISOString(), "2026-03-08T07:30:00.000Z");
    // 07:30Z is after the 07:00Z transition, i.e. 03:30 EDT — moved forward
    // past the gap rather than dropped.
  });

  await t.test("fall back fires once, not twice", () => {
    // 2026-11-01, America/New_York: 02:00 EDT falls back to 01:00 EST, so
    // 01:30 happens twice in wall-clock terms.
    const from = new Date("2026-11-01T00:00:00-04:00");
    const first = nextRun("30 1 * * *", "America/New_York", from)!;
    const second = nextRun("30 1 * * *", "America/New_York", first)!;
    assert.equal(first.toISOString(), "2026-11-01T05:30:00.000Z");
    // The next firing is the following day, not the repeated hour.
    assert.ok(
      second.getTime() - first.getTime() > 20 * 3600_000,
      `expected ~a day between firings, got ${(second.getTime() - first.getTime()) / 3600_000}h`,
    );
  });

  await t.test("invalid cron and timezone are rejected", () => {
    assert.equal(validateCron("not a cron", "UTC").ok, false);
    assert.equal(validateCron("0 7 * * *", "Mars/Olympus_Mons").ok, false);
    assert.equal(validateCron("0 7 * * *", "America/Los_Angeles").ok, true);
  });

  await t.test("preview shows consecutive future firings", () => {
    const runs = previewRuns("0 7 * * *", "UTC", 3);
    assert.equal(runs.length, 3);
    const ts = runs.map((r) => new Date(r).getTime());
    assert.ok(ts[0]! > Date.now());
    assert.ok(ts[1]! > ts[0]! && ts[2]! > ts[1]!);
  });
});

test("schedule claim and recovery", async (t) => {
  process.env.DATABASE_URL = DATABASE_URL;
  process.env.FASTCAR_MOCK = "1";
  await migrate();
  const svc = new AgentService(loadConfig());
  const agent = await svc.create({
    name: `Sched ${RUN}`,
    slug: `sched-${RUN}`.slice(0, 32),
    systemPrompt: "x",
    modelProvider: "inceptionlabs",
    modelSlug: "mercury-2.5",
    tools: ["read"],
  });

  const mk = (over: Partial<schedulesDb.NewSchedule> = {}) =>
    schedulesDb.createSchedule({
      agentId: agent.id,
      name: "nightly",
      prompt: "do the thing",
      cron: "0 7 * * *",
      timezone: "UTC",
      mode: "act",
      enabled: true,
      catchUp: false,
      webhookUrl: null,
      nextRunAt: new Date(Date.now() - 60_000), // already due
      ownerId: null,
      ...over,
    });

  t.after(async () => {
    await getPool().query("DELETE FROM schedules WHERE agent_id = $1", [agent.id]).catch(() => {});
    await getPool().query("DELETE FROM threads WHERE agent_id = $1", [agent.id]).catch(() => {});
    await svc.delete(agent.id).catch(() => {});
    await closePool();
  });

  await t.test("a due schedule appears in the due list", async () => {
    const s = await mk();
    assert.ok((await schedulesDb.dueSchedules()).includes(s.id));
  });

  await t.test("only one of two concurrent claims wins", async () => {
    const s = await mk();
    const next = nextRun(s.cron, s.timezone)!;
    // The real race: two ticks (or two replicas) reaching the same row.
    const [a, b] = await Promise.all([
      schedulesDb.claimSchedule(s.id, next),
      schedulesDb.claimSchedule(s.id, next),
    ]);
    assert.equal([a, b].filter(Boolean).length, 1, "exactly one claim must succeed");
  });

  await t.test("a claim re-bases next_run_at into the future", async () => {
    const s = await mk();
    const next = nextRun(s.cron, s.timezone)!;
    const claimed = await schedulesDb.claimSchedule(s.id, next);
    assert.ok(claimed);
    assert.ok(new Date(claimed!.nextRunAt!).getTime() > Date.now());
    // ...and it is no longer due, so one outage produces one run, not a burst.
    assert.ok(!(await schedulesDb.dueSchedules()).includes(s.id));
  });

  await t.test("a run still in flight blocks the next claim", async () => {
    const s = await mk();
    await schedulesDb.claimSchedule(s.id, nextRun(s.cron, s.timezone)!);
    // Force it due again while last_status is still 'running'.
    await schedulesDb.updateSchedule(s.id, { nextRunAt: new Date(Date.now() - 1000) });
    assert.equal(await schedulesDb.claimSchedule(s.id, new Date()), null);
    assert.ok(!(await schedulesDb.dueSchedules()).includes(s.id), "not offered while running");
  });

  await t.test("boot recovery unwedges a schedule left running", async () => {
    const s = await mk();
    await schedulesDb.claimSchedule(s.id, nextRun(s.cron, s.timezone)!);
    assert.equal((await schedulesDb.getSchedule(s.id))!.lastStatus, "running");

    // Without this, the claim guard would treat the row as busy for 30 minutes
    // after every crash.
    await schedulesDb.resetRunningSchedules();
    const after = await schedulesDb.getSchedule(s.id);
    assert.equal(after!.lastStatus, "error");
    assert.match(after!.lastError!, /restarted/);

    await schedulesDb.updateSchedule(s.id, { nextRunAt: new Date(Date.now() - 1000) });
    assert.ok(await schedulesDb.claimSchedule(s.id, new Date()), "claimable again");
  });

  await t.test("a disabled schedule is never claimed", async () => {
    const s = await mk({ enabled: false });
    assert.ok(!(await schedulesDb.dueSchedules()).includes(s.id));
    assert.equal(await schedulesDb.claimSchedule(s.id, new Date(), true), null);
  });

  await t.test("run-now bypasses the due check but not the running guard", async () => {
    const s = await mk({ nextRunAt: new Date(Date.now() + 86_400_000) }); // not due
    assert.ok(!(await schedulesDb.dueSchedules()).includes(s.id));
    const forced = await schedulesDb.claimSchedule(s.id, new Date(Date.now() + 86_400_000), true);
    assert.ok(forced, "force should claim a schedule that is not due");
    // Still running, so a second force is refused.
    assert.equal(await schedulesDb.claimSchedule(s.id, new Date(), true), null);
  });

  await t.test("deleting a schedule leaves its runs, unlinked", async () => {
    const s = await mk();
    const thread = await threadsDb.createThread("act", "chat", null, agent.id, {
      source: "schedule",
      title: "nightly — 2026-09-20",
    });
    await threadsDb.updateThread(thread.id, { scheduleId: s.id });
    assert.equal((await threadsDb.getThread(thread.id))!.scheduleId, s.id);

    // ON DELETE SET NULL: the run's transcript and artifacts outlive the
    // schedule that produced them.
    await schedulesDb.deleteSchedule(s.id);
    const after = await threadsDb.getThread(thread.id);
    assert.ok(after, "the thread survives");
    assert.equal(after!.scheduleId, null);
    await threadsDb.deleteThread(thread.id);
  });
});
