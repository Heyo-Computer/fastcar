import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";

export interface AskUserBridge {
  /**
   * Surface a question to the UI and resolve with the user's answer.
   * Must reject if the signal aborts.
   */
  ask(
    toolCallId: string,
    question: string,
    options: string[] | undefined,
    signal: AbortSignal | undefined,
  ): Promise<string>;
}

export function createAskUserTool(bridge: AskUserBridge) {
  return defineTool({
    name: "ask_user",
    label: "Ask User",
    description:
      "Ask the user a clarifying question and wait for their answer. Use when a requirement is ambiguous or a decision is genuinely the user's to make. Optionally offer a short list of choices.",
    parameters: Type.Object({
      question: Type.String({ description: "The question to ask the user" }),
      options: Type.Optional(
        Type.Array(Type.String(), { description: "Optional short list of suggested answers" }),
      ),
    }),
    execute: async (toolCallId, params, signal) => {
      const answer = await bridge.ask(toolCallId, params.question, params.options, signal);
      return {
        content: [{ type: "text", text: `User answered: ${answer}` }],
        details: { question: params.question, answer },
      };
    },
  });
}
