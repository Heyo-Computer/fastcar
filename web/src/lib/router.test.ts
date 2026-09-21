/**
 * Route parsing and round-tripping.
 *
 * The hash is the source of truth for navigation, so a parse/serialise
 * mismatch would show up as back/forward quietly landing somewhere else.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { parseHash, toHash, type Route } from "./router.ts";

const CASES: Array<[string, Route]> = [
  ["", { name: "inbox", filter: "all" }],
  ["#/", { name: "inbox", filter: "all" }],
  ["#/inbox?filter=unread", { name: "inbox", filter: "unread" }],
  ["#/inbox?filter=needs_you", { name: "inbox", filter: "needs_you" }],
  ["#/agents", { name: "agents" }],
  ["#/agent/new", { name: "agentNew" }],
  ["#/agent/abc", { name: "agent", agentId: "abc", tab: "threads" }],
  ["#/agent/abc/output", { name: "agent", agentId: "abc", tab: "output" }],
  ["#/agent/abc/schedules", { name: "agent", agentId: "abc", tab: "schedules" }],
  ["#/agent/abc/edit", { name: "agentEdit", agentId: "abc" }],
  ["#/thread/t-1", { name: "thread", threadId: "t-1" }],
  ["#/schedules", { name: "schedules" }],
];

test("router", async (t) => {
  await t.test("parses every route", () => {
    for (const [hash, route] of CASES) {
      assert.deepEqual(parseHash(hash), route, hash);
    }
  });

  await t.test("toHash(parseHash(x)) is stable", () => {
    for (const [hash] of CASES) {
      const once = toHash(parseHash(hash));
      assert.deepEqual(parseHash(once), parseHash(hash), hash);
      assert.equal(toHash(parseHash(once)), once, `not idempotent: ${hash}`);
    }
  });

  await t.test("unknown routes fall back to the inbox rather than a blank page", () => {
    assert.deepEqual(parseHash("#/nonsense"), { name: "inbox", filter: "all" });
    assert.deepEqual(parseHash("#/inbox?filter=bogus"), { name: "inbox", filter: "all" });
    // A bare "#/agent" with no id is the agent list, not a broken agent page.
    assert.deepEqual(parseHash("#/agent"), { name: "agents" });
    // An unknown tab is the default tab, not a blank panel.
    assert.deepEqual(parseHash("#/agent/x/bogus"), { name: "agent", agentId: "x", tab: "threads" });
  });

  await t.test("works with no DOM", () => {
    // The store imports this module at load, including under `node --test`.
    assert.equal(typeof location, "undefined");
    assert.deepEqual(parseHash(), { name: "inbox", filter: "all" });
  });
});
