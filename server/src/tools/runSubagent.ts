import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { StreamEvent } from "@fastcar/shared";
import type { SubagentKind, SubagentManager } from "../pi/subagents.js";

export interface SubagentEventSink {
  (kind: SubagentKind, taskId: string, ev: StreamEvent): void;
}

export function createRunSubagentTool(manager: SubagentManager, onEvent: SubagentEventSink) {
  return defineTool({
    name: "run_subagent",
    label: "Run Subagent",
    description:
      "Delegate work to a subagent. agent=maxcoding: a heavyweight coding agent with full tool access and its own VM — use for all substantial implementation, refactoring, and debugging; it installs whatever it needs, runs the project's tests/build after changing code, and returns a '## Verification' section with the commands it ran. agent=minimodel: a fast read-only research agent — use for exploration, lookups, and summaries. Provide either a single task or a tasks array to run several in parallel. Subagents cannot ask the user questions, so state assumptions in the task.",
    parameters: Type.Object({
      agent: StringEnum(["maxcoding", "minimodel"], {
        description: "Which subagent to use",
      }),
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
      const tasks = params.tasks?.length ? params.tasks : params.task ? [params.task] : [];
      if (!tasks.length) throw new Error("Provide `task` or a non-empty `tasks` array.");
      if (tasks.length > 8) throw new Error("At most 8 parallel tasks are allowed.");

      let completed = 0;
      const results = await Promise.allSettled(
        tasks.map((task, i) =>
          manager
            .run({ kind, task, taskId: `${toolCallId}:${i}`, signal, onEvent })
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
        details: { agent: kind, taskCount: tasks.length },
      };
    },
  });
}
