import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { StreamEvent, UsageSummary } from "@fastcar/shared";

interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
}

export function extractText(message: { content?: unknown }): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as ContentBlock[])
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("");
}

export function extractThinking(message: { content?: unknown }): string {
  const content = message.content;
  if (!Array.isArray(content)) return "";
  return (content as ContentBlock[])
    .filter((b) => b.type === "thinking" && typeof b.thinking === "string")
    .map((b) => b.thinking)
    .join("");
}

export function extractUsage(message: {
  usage?: { input?: number; output?: number; cost?: { total?: number } };
  model?: string;
}): UsageSummary | undefined {
  const usage = message.usage;
  if (!usage) return undefined;
  return {
    model: message.model,
    inputTokens: usage.input,
    outputTokens: usage.output,
    cost: usage.cost?.total,
  };
}

function partialResultToText(partial: unknown): string {
  if (typeof partial === "string") return partial;
  if (partial && typeof partial === "object" && "content" in partial) {
    return extractText(partial as { content?: unknown });
  }
  return "";
}

function resultToText(result: unknown): string {
  if (typeof result === "string") return result;
  if (result && typeof result === "object" && "content" in result) {
    return extractText(result as { content?: unknown });
  }
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

/**
 * Translate a Pi session event into zero or more UI stream events.
 * Deltas are forwarded live; complete items are what get persisted.
 */
export function translateSessionEvent(event: AgentSessionEvent): StreamEvent[] {
  switch (event.type) {
    case "message_start": {
      const role = (event.message as { role?: string }).role;
      return role === "assistant" ? [{ kind: "message_start", role: "assistant" }] : [];
    }
    case "message_update": {
      const ame = event.assistantMessageEvent;
      if (ame.type === "text_delta") return [{ kind: "text_delta", text: ame.delta }];
      if (ame.type === "thinking_delta") return [{ kind: "thinking_delta", text: ame.delta }];
      return [];
    }
    case "message_end": {
      const message = event.message as { role?: string; content?: unknown };
      if (message.role !== "assistant") return [];
      const text = extractText(message);
      const thinking = extractThinking(message);
      const usage = extractUsage(message as Parameters<typeof extractUsage>[0]);
      return [{ kind: "message_end", text, thinking: thinking || undefined, usage }];
    }
    case "tool_execution_start":
      return [{ kind: "tool_start", toolCallId: event.toolCallId, name: event.toolName, args: event.args }];
    case "tool_execution_update":
      return [
        {
          kind: "tool_update",
          toolCallId: event.toolCallId,
          output: partialResultToText(event.partialResult),
        },
      ];
    case "tool_execution_end":
      return [
        {
          kind: "tool_end",
          toolCallId: event.toolCallId,
          ok: !event.isError,
          result: resultToText(event.result),
        },
      ];
    default:
      return [];
  }
}
