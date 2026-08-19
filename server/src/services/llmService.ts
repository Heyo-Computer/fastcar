import type { Context, Model } from "@earendil-works/pi-ai";
import type { FastcarModels } from "../pi/runtime.js";

/**
 * One-shot LLM completion (Feature 3): run a prompt through a model and return
 * the text. Uses the shared ModelRuntime's `complete()` against the conductor
 * model, with no tools and a single user turn — a fire-and-forget generation
 * for prompt threads, distinct from the agentic `AgentSession` loop.
 */
export async function completePrompt(
  models: FastcarModels,
  prompt: string,
): Promise<string> {
  const model = models.conductor as Model<"openai-completions">;
  const context: Context = {
    systemPrompt:
      "You are a helpful assistant. Answer the user's prompt directly and concisely.",
    messages: [
      {
        role: "user",
        content: prompt,
        timestamp: Date.now(),
      },
    ],
  };
  const message = await models.runtime.complete(model, context);
  return extractText(message);
}

function extractText(message: { content?: unknown }): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as Array<{ type: string; text?: string }>)
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("");
}
