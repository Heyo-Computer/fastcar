import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { StreamEvent } from "@fastcar/shared";
import {
  isReadOnlySubagentRun,
  type SubagentKind,
  type SubagentManager,
  type SubagentMode,
} from "../pi/subagents.js";

export interface SubagentEventSink {
  (kind: SubagentKind, taskId: string, ev: StreamEvent): void;
}

/**
 * True when this run_subagent call cannot change anything on the VM, i.e. it
 * is safe to run while the thread is in plan mode. Takes the raw (validated)
 * tool arguments so the conductor's per-call gate can decide without
 * re-parsing.
 */
export function isReadOnlySubagentCall(args: unknown): boolean {
  const a = (args ?? {}) as { agent?: SubagentKind; mode?: SubagentMode };
  if (!a.agent) return false;
  return isReadOnlySubagentRun(a.agent, a.mode);
}

export function createRunSubagentTool(manager: SubagentManager, onEvent: SubagentEventSink) {
  return defineTool({
    name: "run_subagent",
    label: "Run Subagent",
    description:
      "Delegate work to a subagent. agent=maxcoding: a heavyweight coding agent with full tool access and its own VM — use for all substantial implementation, refactoring, and debugging; it installs whatever it needs, runs the project's tests/build after changing code, and returns a '## Verification' section with the commands it ran. With mode=plan, maxcoding is read-only: it explores and returns an implementation plan plus a '## Questions for the user' section listing the decisions only the user can make — use it for complex or ambiguous tasks before implementing, and it is allowed while the thread is in planning mode. agent=minimodel: a fast read-only research agent — use for exploration, lookups, and summaries. Provide either a single task or a tasks array to run several in parallel (fan exploration and planning out this way too). Subagents cannot talk to the user: state assumptions in the task, and relay any '## Questions for the user' they return with ask_user.",
    parameters: Type.Object({
      agent: StringEnum(["maxcoding", "minimodel"], {
        description: "Which subagent to use",
      }),
      mode: Type.Optional(
        StringEnum(["implement", "plan"], {
          description:
            "maxcoding only. implement (default): change code and verify it. plan: read-only — explore and return a plan plus questions for the user; the only maxcoding mode allowed in planning mode. Ignored for minimodel, which is always read-only.",
        }),
      ),
      task: Type.Optional(
        Type.String({
          description:
            "A single, self-contained task prompt. For maxcoding, state the goal, the acceptance criteria, and how to verify the result (which tests, build, or lint to run).",
        }),
      ),
      tasks: Type.Optional(
        Type.Array(Type.String(), {
          description: "Multiple self-contained tasks to run in parallel (max 8)",
        }),
      ),
    }),
    execute: async (toolCallId, params, signal, onUpdate) => {
      const kind = params.agent as SubagentKind;
      const mode = (params.mode ?? "implement") as SubagentMode;
      const tasks = params.tasks?.length ? params.tasks : params.task ? [params.task] : [];
      if (!tasks.length) throw new Error("Provide `task` or a non-empty `tasks` array.");
      if (tasks.length > 8) throw new Error("At most 8 parallel tasks are allowed.");

      let completed = 0;
      const results = await Promise.allSettled(
        tasks.map((task, i) =>
          manager
            .run({ kind, mode, task, taskId: `${toolCallId}:${i}`, signal, onEvent })
            .then((r) => {
              completed++;
              onUpdate?.({
                content: [{ type: "text", text: `${completed}/${tasks.length} tasks complete` }],
                details: {},
              });
              return r;
            }),
        ),
      );

      const sections = results.map((res, i) => {
        const header = tasks.length > 1 ? `## Task ${i + 1}: ${tasks[i]}\n` : "";
        if (res.status === "fulfilled") {
          const { report, usage } = res.value;
          const usageLine = usage.outputTokens
            ? `\n\n(usage: ${usage.inputTokens ?? "?"} in / ${usage.outputTokens} out tokens${
                usage.cost ? `, $${usage.cost.toFixed(4)}` : ""
              })`
            : "";
          return `${header}${report}${usageLine}`;
        }
        return `${header}FAILED: ${res.reason instanceof Error ? res.reason.message : String(res.reason)}`;
      });

      const anyFailure = results.some((r) => r.status === "rejected");
      if (anyFailure && results.every((r) => r.status === "rejected")) {
        throw new Error(`All subagent tasks failed:\n${sections.join("\n\n")}`);
      }
      return {
        content: [{ type: "text", text: sections.join("\n\n") }],
        details: { agent: kind, mode, taskCount: tasks.length },
      };
    },
  });
}
