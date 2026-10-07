import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import {
  compactionSettings,
  PRUNE_MIN_CHARS,
  pruneStaleToolResults,
} from "../pi/contextPruning.js";
import { translateSessionEvent } from "../pi/events.js";

type Msg = { role: string; toolName?: string; content: { type: string; text?: string }[] };

const assistant = (): Msg => ({ role: "assistant", content: [] });
const result = (text: string, toolName = "browser_check"): Msg => ({
  role: "toolResult",
  toolName,
  content: [{ type: "text", text }],
});
const textOf = (m: Msg): string => m.content.map((b) => b.text ?? "").join("");

describe("pruneStaleToolResults", () => {
  const big = "y".repeat(PRUNE_MIN_CHARS * 5);

  it("trims large results older than the last three rounds, keeping a head", () => {
    const msgs = [assistant(), result(big), assistant(), result(big), assistant(), result(big), assistant(), result(big)];
    const out = pruneStaleToolResults(msgs);
    assert.ok(textOf(out[1]!).includes("browser_check output trimmed"));
    assert.ok(textOf(out[1]!).startsWith("yyy"));
    assert.ok(textOf(out[1]!).length < 1_000);
    // Results of the last three rounds are the same objects.
    assert.equal(out[3], msgs[3]);
    assert.equal(out[5], msgs[5]);
    assert.equal(out[7], msgs[7]);
  });

  it("never mutates its input, and returns it as-is when nothing qualifies", () => {
    const small = [assistant(), result("short"), assistant(), assistant(), assistant()];
    assert.equal(pruneStaleToolResults(small), small);

    const msgs = [assistant(), result(big), assistant(), assistant(), assistant()];
    pruneStaleToolResults(msgs);
    assert.equal(textOf(msgs[1]!), big);
  });

  it("leaves a short conversation alone", () => {
    const msgs = [assistant(), result(big), assistant()];
    assert.equal(pruneStaleToolResults(msgs), msgs);
  });
});

describe("compaction", () => {
  it("compacts at half the context window", () => {
    assert.deepEqual(compactionSettings(128_000), {
      enabled: true,
      reserveTokens: 64_000,
      keepRecentTokens: 10_000,
    });
  });

  const end = (e: Partial<Extract<AgentSessionEvent, { type: "compaction_end" }>>) =>
    translateSessionEvent({
      type: "compaction_end",
      reason: "threshold",
      result: undefined,
      aborted: false,
      willRetry: false,
      ...e,
    } as AgentSessionEvent);

  it("reports an automatic compaction as a system row", () => {
    const [ev] = end({
      result: { summary: "s", firstKeptEntryId: "x", tokensBefore: 118_589, estimatedTokensAfter: 27_100 },
    });
    assert.equal(ev?.kind, "system");
    assert.match((ev as { text: string }).text, /119k → ~27k/);
  });

  it("surfaces a failed automatic compaction as an error", () => {
    const [ev] = end({ reason: "overflow", errorMessage: "Context overflow recovery failed" });
    assert.deepEqual(ev, { kind: "error", message: "Context overflow recovery failed" });
  });

  it("stays quiet for manual and aborted compactions", () => {
    const result = { summary: "s", firstKeptEntryId: "x", tokensBefore: 1, estimatedTokensAfter: 1 };
    assert.deepEqual(end({ reason: "manual", result }), []);
    assert.deepEqual(end({ aborted: true }), []);
  });
});
