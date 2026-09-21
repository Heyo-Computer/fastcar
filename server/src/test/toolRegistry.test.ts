/**
 * Frozen snapshots of the tool wiring as it was before tools/registry.ts
 * existed.
 *
 * The registry replaced two hand-written literal arrays (the conductor's
 * allowlist, the three subagent presets) and a hand-assembled mutating set.
 * Those lists decide what every agent in the system can do, and a quietly
 * dropped or added name would not fail any other test — the mock LLM does not
 * care which tools it was offered. So the literals below are copied from the
 * pre-refactor source and must not be "fixed" to match the code: if one fails,
 * the registry changed behaviour.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildToolset,
  CHANGE_EVIDENCE_TOOLS,
  CONDUCTOR_DEFAULT_TOOLS,
  CONDITIONAL_PLAN_TOOLS,
  listTools,
  MUTATING_TOOL_NAMES,
  SUBAGENT_PRESETS,
  TOOLS,
  type ToolContext,
} from "../tools/registry.js";
import type { Config } from "../config.js";

// --- frozen: conductor.ts:123-132, with every dependency wired in ----------
const CONDUCTOR_ALLOWLIST = [
  "read", "bash", "edit", "write", "grep", "find", "ls",
  "run_subagent", "ask_user", "submit_plan",
  "memory_save", "memory_search", "memory_list", "memory_delete",
  "web_search", "browser_check", "email",
  "git_clone", "git_pull", "git_checkout", "git_commit", "git_push",
  "git_status", "git_purge", "git_list_repos",
  "heyctl",
  "create_artifact", "update_artifact", "list_artifacts",
  "mcp_install", "mcp_remove", "mcp_list_servers", "mcp_list_tools", "mcp_call",
];

// --- frozen: conductor.ts:43-52 --------------------------------------------
const MUTATING = [
  "bash", "create_artifact", "edit", "git_checkout", "git_clone", "git_commit",
  "git_pull", "git_purge", "git_push", "heyctl", "mcp_install", "mcp_remove",
  "memory_delete", "update_artifact", "write",
];

// --- frozen: subagents.ts:83-103 -------------------------------------------
const PRESETS: Record<string, string[]> = {
  maxcoding: [
    "read", "bash", "edit", "write", "grep", "find", "ls", "web_search", "browser_check",
    "git_pull", "git_checkout", "git_commit", "git_push", "git_status", "git_list_repos",
    "heyctl", "mcp_list_servers", "mcp_list_tools", "mcp_call",
  ],
  "maxcoding:plan": [
    "read", "grep", "find", "ls", "web_search", "git_status", "git_list_repos",
    "heyctl", "mcp_list_servers", "mcp_list_tools",
  ],
  minimodel: [
    "read", "grep", "find", "ls", "web_search", "git_status", "git_list_repos",
    "mcp_list_servers", "mcp_list_tools",
  ],
};

const cfg = { dataDir: "/tmp/fastcar-test", workdir: "/tmp" } as unknown as Config;
const stub = <T,>() => ({}) as T;

/** Every optional dependency present — the production conductor's situation. */
function fullCtx(): ToolContext {
  return {
    cfg,
    threadId: "00000000-0000-0000-0000-000000000000",
    subagents: stub(),
    onSubagentEvent: () => {},
    askBridge: { ask: async () => "" },
    planBridge: { submit: () => {} },
    email: stub(),
    artifacts: stub(),
    mcp: stub(),
  };
}

test("tool registry", async (t) => {
  await t.test("the conductor allowlist is unchanged", () => {
    assert.deepEqual([...CONDUCTOR_DEFAULT_TOOLS], CONDUCTOR_ALLOWLIST);
    assert.deepEqual(buildToolset(CONDUCTOR_DEFAULT_TOOLS, fullCtx()).tools, CONDUCTOR_ALLOWLIST);
  });

  await t.test("the plan-mode mutating set is unchanged", () => {
    assert.deepEqual([...MUTATING_TOOL_NAMES].sort(), MUTATING);
  });

  await t.test("subagent presets are unchanged", () => {
    for (const [pool, want] of Object.entries(PRESETS)) {
      assert.deepEqual([...SUBAGENT_PRESETS[pool as keyof typeof SUBAGENT_PRESETS]], want, pool);
    }
  });

  await t.test("a missing dependency drops its tools, as the old conditionals did", () => {
    const ctx = { ...fullCtx(), email: undefined, artifacts: undefined, mcp: undefined };
    const { tools, dropped } = buildToolset(CONDUCTOR_DEFAULT_TOOLS, ctx);
    const gone = ["email", "create_artifact", "update_artifact", "list_artifacts",
                  "mcp_install", "mcp_remove", "mcp_list_servers", "mcp_list_tools", "mcp_call"];
    assert.deepEqual(tools, CONDUCTOR_ALLOWLIST.filter((n) => !gone.includes(n)));
    assert.deepEqual(dropped.sort(), [...gone].sort());
  });

  await t.test("customTools and the allowlist always agree", () => {
    // Pi fixes the tool registry at session creation and an allowlist naming
    // only builtins disables every custom tool, so a mismatch here silently
    // removes a tool the agent was granted.
    for (const allowlist of [CONDUCTOR_DEFAULT_TOOLS, ...Object.values(SUBAGENT_PRESETS)]) {
      const { tools, customTools } = buildToolset(allowlist, fullCtx());
      const named = new Set(tools);
      for (const ct of customTools) {
        assert.ok(named.has(ct.name), `${ct.name} instantiated but not in the allowlist`);
      }
      const builtins = new Set(TOOLS.filter((x) => x.builtin).map((x) => x.name));
      for (const n of tools) {
        if (builtins.has(n)) continue;
        assert.ok(customTools.some((c) => c.name === n), `${n} allowlisted but never built`);
      }
    }
  });

  await t.test("a group factory only yields the names the allowlist asked for", () => {
    // createGitTools always returns all eight; granting git_status alone must
    // not smuggle in git_push.
    const { tools, customTools } = buildToolset(["git_status"], fullCtx());
    assert.deepEqual(tools, ["git_status"]);
    assert.deepEqual(customTools.map((c) => c.name), ["git_status"]);
  });

  await t.test("unknown names are dropped rather than thrown", () => {
    const { tools, dropped } = buildToolset(["read", "not_a_tool"], fullCtx());
    assert.deepEqual(tools, ["read"]);
    assert.deepEqual(dropped, ["not_a_tool"]);
  });

  await t.test("duplicates collapse", () => {
    assert.deepEqual(buildToolset(["read", "read", "grep"], fullCtx()).tools, ["read", "grep"]);
  });

  await t.test("every conditional-plan tool has a gate in conductor.ts", () => {
    // conductor.ts fails closed on anything in this set without a branch, so
    // this is really a reminder that adding one means adding a branch.
    assert.deepEqual([...CONDITIONAL_PLAN_TOOLS].sort(), ["mcp_call", "run_subagent"]);
  });

  await t.test("change-evidence stays distinct from plan-mode mutation", () => {
    // Widening this to MUTATING_TOOL_NAMES would change when a subagent is
    // sent back for a missing ## Verification section.
    assert.deepEqual([...CHANGE_EVIDENCE_TOOLS], ["edit", "write", "bash"]);
  });

  await t.test("the catalog is well formed", () => {
    const names = TOOLS.map((x) => x.name);
    assert.equal(new Set(names).size, names.length, "duplicate tool name");
    for (const def of TOOLS) {
      assert.ok(def.label && def.description, `${def.name} needs a label and description`);
      assert.equal(def.builtin, !def.group, `${def.name}: builtins have no group, others must`);
    }
  });

  await t.test("listTools reports availability with a reason", () => {
    const rows = listTools({ email: false, artifacts: true, mcp: true });
    const email = rows.find((r) => r.name === "email")!;
    assert.equal(email.available, false);
    assert.match(email.unavailableReason!, /SMTP/);
    assert.equal(rows.find((r) => r.name === "read")!.available, true);
    assert.equal(rows.find((r) => r.name === "ask_user")!.alwaysOn, true);
  });
});
