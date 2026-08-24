import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { loadConfig } from "../config.js";
import { migrate } from "../db/migrate.js";
import { closePool } from "../db/pool.js";
import { buildModels } from "../pi/runtime.js";
import { SubagentManager, type SubagentKind } from "../pi/subagents.js";
import { startMockOpenAI } from "../dev/mock-openai.js";
import type { StreamEvent } from "@fastcar/shared";

// Verifies the parallel-subagent control surface added in subagents.ts:
//   - cancel(taskId) aborts an in-flight run via the AbortController map
//   - cancel is a safe no-op for an unknown taskId
//   - a caller-supplied signal still propagates to the run (conductor abort)
// The run goes through the real Pi loop against the mock OpenAI server, so the
// abort reaches the underlying agent session the same way a real cancel would.

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://fastcar:fastcar@127.0.0.1:5432/fastcar";

const TASK_ID = "test-cancel-task-1";

describe("subagent control (cancel + signal forwarding)", () => {
  let cfg: ReturnType<typeof loadConfig>;
  let mockOpenAI: http.Server | undefined;
  let manager: SubagentManager;

  before(async () => {
    process.env.FASTCAR_MOCK = "1";
    process.env.DATABASE_URL = DATABASE_URL;
    cfg = loadConfig();
    mockOpenAI = cfg.mock ? await startMockOpenAI(cfg.mockPort) : undefined;
    await migrate();
    const models = await buildModels(cfg);
    manager = new SubagentManager(models, cfg);
  });

  after(async () => {
    mockOpenAI?.close();
    await closePool();
  });

  it("cancel is a no-op for an unknown taskId", () => {
    // Must not throw and must not abort anything.
    manager.cancel("definitely-not-running");
  });

  it("cancel(taskId) aborts an in-flight subagent run", async () => {
    const events: StreamEvent[] = [];
    const runPromise = manager.run({
      kind: "minimodel" as SubagentKind,
      task: "Summarize the current directory.",
      taskId: TASK_ID,
      signal: undefined,
      onEvent: (_kind, _taskId, ev) => {
        events.push(ev);
        // Cancel as soon as the run is alive and producing events — by this
        // point the controller is stored in the manager's map.
        manager.cancel(TASK_ID);
      },
    });

    // The run should reject because the abort propagated to the session and the
    // post-prompt guard raised "subagent aborted".
    await assert.rejects(runPromise, (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      return /abort/i.test(msg);
    });
  });

  it("maxcoding mode=plan runs read-only and returns a plan with questions", async () => {
    const toolsUsed = new Set<string>();
    const { report } = await manager.run({
      kind: "maxcoding" as SubagentKind,
      mode: "plan",
      task: "Write an implementation plan for a mock refactor.",
      taskId: "test-plan-mode-task",
      signal: undefined,
      onEvent: (_kind, _taskId, ev) => {
        if (ev.kind === "tool_start") toolsUsed.add(ev.name);
      },
    });

    // The planning pool has no mutating tools at all, so even a model that
    // wanted to edit could not — and the verification follow-up never fires.
    for (const name of toolsUsed) {
      assert.ok(!["bash", "edit", "write"].includes(name), `planning run used mutating tool ${name}`);
    }
    assert.ok(toolsUsed.size > 0, "planning run explored with read-only tools");
    assert.match(report, /## Questions for the user/);
    assert.doesNotMatch(report, /## Verification\n- `npm test` — passed \(mock/);
  });

  it("a caller-supplied signal still propagates to the run", async () => {
    const external = new AbortController();
    const runPromise = manager.run({
      kind: "minimodel" as SubagentKind,
      task: "Summarize the current directory.",
      taskId: "test-signal-forward-task",
      signal: external.signal,
      onEvent: () => {
        // Trigger the conductor-side abort path; the internal controller must
        // forward it into the session.
        external.abort();
      },
    });

    await assert.rejects(runPromise, (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      return /abort/i.test(msg);
    });
  });
});
