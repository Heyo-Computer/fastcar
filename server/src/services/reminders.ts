/**
 * The reminder sweep: every TICK_MS, claim due reminders and post each one
 * back into the thread that set it.
 *
 * Like the scheduler, the loop is DB-driven: `due_at` is persisted, so a
 * reminder survives a restart and one that came due during downtime simply
 * fires on the first sweep after boot.
 */
import * as remindersDb from "../db/reminders.js";
import type { ReminderRecord } from "../db/reminders.js";

const TICK_MS = 30_000;

/** What the sweep needs from the ThreadManager; narrow so tests can fake it. */
export interface ReminderTarget {
  /**
   * Start a turn on the thread with this text. Resolves "busy" — without
   * touching the thread — when it is mid-run or waiting on the user.
   */
  deliverReminder(threadId: string, text: string): Promise<"delivered" | "busy">;
}

/** The turn the agent receives when a reminder fires. */
export function reminderPrompt(r: ReminderRecord): string {
  return `⏰ Reminder (set ${r.createdAt}, due ${r.dueAt}): ${r.message}`;
}

export class ReminderService {
  private timer: NodeJS.Timeout | null = null;
  private sweeping = false;

  constructor(private readonly target: ReminderTarget) {}

  async start(): Promise<void> {
    // A crash between claim and delivery leaves rows 'firing' forever.
    const reset = await remindersDb.resetFiringReminders();
    if (reset) console.log(`reminders: reset ${reset} reminder(s) left firing by a previous process`);
    this.timer = setInterval(() => void this.sweep(), TICK_MS);
    this.timer.unref?.();
    void this.sweep();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One pass over due reminders. Overlapping sweeps are skipped. */
  async sweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      for (const r of await remindersDb.claimDueReminders()) {
        await this.fire(r);
      }
    } catch (err) {
      console.error("reminder sweep failed:", err);
    } finally {
      this.sweeping = false;
    }
  }

  private async fire(r: ReminderRecord): Promise<void> {
    try {
      const outcome = await this.target.deliverReminder(r.threadId, reminderPrompt(r));
      if (outcome === "busy") {
        // Interrupting a running turn (or a pending question) would scramble
        // it; the next sweep tries again once the thread has settled.
        await remindersDb.releaseReminder(r.id, "thread was busy; retrying");
        return;
      }
      await remindersDb.markFired(r.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`reminder ${r.id} failed:`, err);
      await remindersDb.markError(r.id, message).catch(() => {});
    }
  }
}
