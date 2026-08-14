import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";

export interface SubmitPlanBridge {
  /** Record the submitted plan; the thread transitions to awaiting_approval after the turn ends. */
  submit(planMarkdown: string): void;
}

export function createSubmitPlanTool(bridge: SubmitPlanBridge) {
  return defineTool({
    name: "submit_plan",
    label: "Submit Plan",
    description:
      "Submit your finished implementation plan (markdown) for user review. Planning mode only. Call exactly once, when the plan is complete. Do not begin implementing.",
    parameters: Type.Object({
      plan: Type.String({ description: "The complete plan as markdown" }),
    }),
    execute: async (_toolCallId, params) => {
      bridge.submit(params.plan);
      return {
        content: [
          {
            type: "text",
            text: "Plan submitted for user review. Stop here and wait — do not take further actions this turn.",
          },
        ],
        details: {},
      };
    },
  });
}
