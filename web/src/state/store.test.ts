/**
 * Reducer parity.
 *
 * `applyStreamEvent` (live WS deltas) and `applyPersistedEvent` (history
 * replayed from Postgres on page load) build the same ChatItem[] from two
 * different inputs. Nothing enforced that until this test: the invariant lived
 * in a comment, and a change to one reducer could silently make a reloaded
 * thread render differently from the one you just watched stream.
 *
 * Run with: npm run test:web
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { PersistedEvent, StreamEvent } from "@fastcar/shared";
import {
  applyPersistedEvent,
  applyStreamEvent,
  type ChatItem,
} from "./store.ts";

/** `key` is a render-time counter, not content — it can't match across runs. */
function stripKeys(items: ChatItem[]): unknown {
  return JSON.parse(JSON.stringify(items, (k, v) => (k === "key" ? undefined : v)));
}

type Live = { agent: string; taskId?: string; ev: StreamEvent };

/**
 * One run exercising every branch that differs between the reducers: a
 * conductor message, a run_subagent tool card, two subagent tasks nested
 * underneath it by taskId, a question/answer pair, and a final report.
 */
const TOOL_ID = "call_1";
const TASK_A = `${TOOL_ID}:0`;
const TASK_B = `${TOOL_ID}:1`;

const LIVE: Live[] = [
  { agent: "conductor", ev: { kind: "user_message", text: "ship it" } },
  { agent: "conductor", ev: { kind: "message_start", role: "assistant" } },
  { agent: "conductor", ev: { kind: "text_delta", text: "Delegating" } },
  { agent: "conductor", ev: { kind: "text_delta", text: " now." } },
  { agent: "conductor", ev: { kind: "message_end", text: "Delegating now." } },
  {
    agent: "conductor",
    ev: { kind: "tool_start", toolCallId: TOOL_ID, name: "run_subagent", args: { agent: "maxcoding" } },
  },
  { agent: "maxcoding", taskId: TASK_A, ev: { kind: "tool_start", toolCallId: "t1", name: "read", args: { path: "a.ts" } } },
  { agent: "maxcoding", taskId: TASK_A, ev: { kind: "tool_end", toolCallId: "t1", ok: true, result: "ok" } },
  { agent: "maxcoding", taskId: TASK_A, ev: { kind: "message_end", text: "Report A" } },
  { agent: "minimodel", taskId: TASK_B, ev: { kind: "message_end", text: "Report B" } },
  { agent: "conductor", ev: { kind: "tool_end", toolCallId: TOOL_ID, ok: true, result: "2 tasks complete" } },
  { agent: "conductor", ev: { kind: "question", questionId: "q1", prompt: "Deploy?", options: ["yes", "no"] } },
  { agent: "conductor", ev: { kind: "answer", questionId: "q1", text: "yes" } },
  { agent: "conductor", ev: { kind: "message_end", text: "Done." } },
];

let seq = 0;

/** The same run as the server would have written it to `events`. */
const PERSISTED: PersistedEvent[] = [
  row("conductor", null, "user_message", { text: "ship it" }),
  row("conductor", null, "assistant_text", { text: "Delegating now.", thinking: "" }),
  row("conductor", null, "tool_call", {
    phase: "start", toolCallId: TOOL_ID, name: "run_subagent", args: { agent: "maxcoding" },
  }),
  row("maxcoding", TASK_A, "tool_call", { phase: "start", toolCallId: "t1", name: "read", args: { path: "a.ts" } }),
  row("maxcoding", TASK_A, "tool_call", { phase: "end", toolCallId: "t1", ok: true, result: "ok" }),
  row("maxcoding", TASK_A, "assistant_text", { text: "Report A" }),
  row("minimodel", TASK_B, "assistant_text", { text: "Report B" }),
  row("conductor", null, "tool_call", { phase: "end", toolCallId: TOOL_ID, ok: true, result: "2 tasks complete" }),
  row("conductor", null, "question", { questionId: "q1", prompt: "Deploy?", options: ["yes", "no"] }),
  row("conductor", null, "answer", { questionId: "q1", text: "yes" }),
  row("conductor", null, "assistant_text", { text: "Done.", thinking: "" }),
];

function row(
  agent: string,
  taskId: string | null,
  kind: PersistedEvent["kind"],
  payload: Record<string, unknown>,
): PersistedEvent {
  return { seq: ++seq, agent, taskId, kind, payload, createdAt: new Date(0).toISOString() };
}

function reduceLive(): ChatItem[] {
  const items: ChatItem[] = [];
  for (const { agent, taskId, ev } of LIVE) applyStreamEvent(items, agent, taskId, ev);
  return items;
}

function reducePersisted(): ChatItem[] {
  const items: ChatItem[] = [];
  for (const r of PERSISTED) applyPersistedEvent(items, r);
  return items;
}

test("live and replayed reducers produce the same transcript", () => {
  assert.deepEqual(stripKeys(reduceLive()), stripKeys(reducePersisted()));
});

test("subagent events nest under their run_subagent card in both reducers", () => {
  for (const items of [reduceLive(), reducePersisted()]) {
    const tool = items.find((i) => i.type === "tool" && i.toolCallId === TOOL_ID);
    assert.ok(tool && tool.type === "tool", "run_subagent card exists");
    assert.equal(tool.subs.length, 2, "both subagent tasks nested");
    assert.deepEqual(
      tool.subs.map((s) => s.taskId).sort(),
      [TASK_A, TASK_B],
    );
    // Nesting must not leak the subagent report into the top-level transcript.
    const topLevelTexts = items.flatMap((i) => (i.type === "assistant" ? [i.text] : []));
    assert.ok(!topLevelTexts.includes("Report A"));
    assert.ok(!topLevelTexts.includes("Report B"));
  }
});

test("a user-defined top-level agent slug is not mistaken for a subagent", () => {
  // Guards the rename that is coming: once threads are owned by user-created
  // agents, top-level events carry an arbitrary slug instead of "conductor".
  // They must still render as top-level items, not get routed into findSub.
  const items: ChatItem[] = [];
  for (const { agent, taskId, ev } of LIVE) {
    // Only the top-level agent is renamed; the subagents keep their names.
    applyStreamEvent(items, taskId ? agent : "news-desk", taskId, ev);
  }
  assert.deepEqual(stripKeys(items), stripKeys(reduceLive()));
});
