import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { cancelReminder, createReminder, listReminders, type ReminderRecord } from "../db/reminders.js";

/** Far enough for "check back next quarter", short of a typo'd year. */
const MAX_AHEAD_MS = 366 * 24 * 3600_000;

/** "in 2h 5m" / "5m ago" — the model rarely knows the wall clock, so say both. */
export function relative(target: Date, now = new Date()): string {
  const ms = target.getTime() - now.getTime();
  let mins = Math.round(Math.abs(ms) / 60_000);
  const d = Math.floor(mins / 1440);
  mins -= d * 1440;
  const h = Math.floor(mins / 60);
  mins -= h * 60;
  const parts = [d && `${d}d`, h && `${h}h`, (mins || (!d && !h)) && `${mins}m`].filter(Boolean).join(" ");
  return ms >= 0 ? `in ${parts}` : `${parts} ago`;
}

/** Resolve the tool's two ways of saying "when". Throws a message the model can act on. */
export function resolveDueAt(
  params: { delay_minutes?: number; at?: string },
  now = new Date(),
): Date {
  const hasDelay = params.delay_minutes !== undefined;
  const hasAt = params.at !== undefined && params.at.trim() !== "";
  if (hasDelay === hasAt) throw new Error("pass exactly one of delay_minutes or at");

  let due: Date;
  if (hasDelay) {
    const n = params.delay_minutes!;
    if (!Number.isFinite(n) || n <= 0) throw new Error("delay_minutes must be a positive number");
    due = new Date(now.getTime() + n * 60_000);
  } else {
    // A bare local time would be interpreted in the server's zone, which is
    // never what the agent meant — require an explicit offset.
    const raw = params.at!.trim();
    if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(raw)) {
      throw new Error(`"at" must be an ISO 8601 timestamp with a timezone offset, e.g. 2026-10-02T09:00:00-07:00`);
    }
    due = new Date(raw);
    if (Number.isNaN(due.getTime())) throw new Error(`could not parse "at": ${raw}`);
    if (due.getTime() <= now.getTime()) {
      throw new Error(`"at" is in the past (${due.toISOString()}; now is ${now.toISOString()})`);
    }
  }
  if (due.getTime() - now.getTime() > MAX_AHEAD_MS) throw new Error("reminders can be at most a year ahead");
  return due;
}

function line(r: ReminderRecord, now = new Date()): string {
  const when = new Date(r.dueAt);
  const state = r.status === "pending" ? relative(when, now) : r.status;
  return `- [${r.id}] ${r.dueAt} (${state}): ${r.message}`;
}

export function createReminderTools(threadId: string) {
  const create = defineTool({
    name: "reminder_create",
    label: "Set Reminder",
    description:
      "Schedule a follow-up for yourself on this conversation. When it comes due, the message is posted back " +
      "into this thread as a new turn and you resume with the full context — use it to check on something later " +
      "(a reply that has not arrived, a deploy, a deadline). Give exactly one of delay_minutes or at.",
    parameters: Type.Object({
      message: Type.String({
        description: "What to do when it fires, written as an instruction to your future self — include the ids, names and URLs you will need",
      }),
      delay_minutes: Type.Optional(Type.Number({ description: "Fire this many minutes from now" })),
      at: Type.Optional(
        Type.String({ description: "Fire at this ISO 8601 timestamp; must include a timezone offset (Z or ±hh:mm)" }),
      ),
    }),
    execute: async (_id, params) => {
      if (!params.message.trim()) throw new Error("message cannot be empty");
      const now = new Date();
      const due = resolveDueAt(params, now);
      const r = await createReminder(threadId, params.message.trim(), due);
      return {
        content: [
          {
            type: "text",
            text: `Reminder ${r.id} set for ${r.dueAt} (${relative(due, now)}; it is now ${now.toISOString()}).`,
          },
        ],
        details: { id: r.id, dueAt: r.dueAt },
      };
    },
  });

  const list = defineTool({
    name: "reminder_list",
    label: "List Reminders",
    description: "List this thread's pending reminders, soonest first. Pass include_done to also see fired and cancelled ones.",
    parameters: Type.Object({
      include_done: Type.Optional(Type.Boolean({ description: "Include fired, cancelled and failed reminders" })),
    }),
    execute: async (_id, params) => {
      const rows = await listReminders(threadId, params.include_done ?? false);
      const now = new Date();
      const text = rows.length
        ? `It is now ${now.toISOString()}.\n${rows.map((r) => line(r, now)).join("\n")}`
        : "No reminders on this thread.";
      return { content: [{ type: "text", text }], details: { count: rows.length } };
    },
  });

  const cancel = defineTool({
    name: "reminder_cancel",
    label: "Cancel Reminder",
    description: "Cancel a pending reminder by id (from reminder_list or reminder_create).",
    parameters: Type.Object({
      id: Type.String({ description: "Reminder id (uuid)" }),
    }),
    execute: async (_id, params) => {
      const ok = await cancelReminder(params.id, threadId);
      return {
        content: [{ type: "text", text: ok ? "Cancelled." : "No pending reminder with that id on this thread." }],
        details: { cancelled: ok },
      };
    },
  });

  return [create, list, cancel];
}
