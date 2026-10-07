/**
 * Context-window management on top of Pi's compaction.
 *
 * Pi's defaults compact only when the context is within `reserveTokens` of the
 * window and keep ~20k recent tokens, so a 128k Mercury conductor ran between
 * ~40k and ~125k tokens — slow, rate-limited (every tool call resends it all),
 * and noticeably worse at tool use near the top. Two levers live here:
 *
 * - compactionSettings(): compact at half the window and keep less.
 * - pruneStaleToolResults(): a transformContext hook that trims bulky tool
 *   output (browser_check, web_search, mcp_list_tools …) once it is a few model
 *   rounds old. It only changes what the model is sent; the JSONL session and
 *   the compaction summarizer still see the full results.
 */
import type { CompactionSettings } from "@earendil-works/pi-coding-agent";

/** Model rounds (assistant messages) whose tool results stay untouched. */
export const KEEP_RECENT_ROUNDS = 3;
/** Results shorter than this are never trimmed — a stub would save little. */
export const PRUNE_MIN_CHARS = 2_000;
/** How much of a trimmed result's text survives, for orientation. */
export const PRUNE_HEAD_CHARS = 400;

export function compactionSettings(contextWindow: number): CompactionSettings {
  return {
    enabled: true,
    // Compaction fires once context > window - reserve, i.e. at half the window.
    reserveTokens: Math.floor(contextWindow / 2),
    keepRecentTokens: 10_000,
  };
}

interface Block {
  type: string;
  text?: string;
}

interface ToolResultLike {
  role: "toolResult";
  toolName?: string;
  content: Block[];
}

function isToolResult(message: unknown): message is ToolResultLike {
  return (
    !!message &&
    typeof message === "object" &&
    (message as { role?: unknown }).role === "toolResult" &&
    Array.isArray((message as { content?: unknown }).content)
  );
}

function contentChars(content: Block[]): number {
  // Non-text blocks (images) are counted as large so they always get trimmed.
  return content.reduce((n, b) => n + (b.type === "text" ? (b.text?.length ?? 0) : PRUNE_MIN_CHARS), 0);
}

/**
 * Replace the content of tool results older than the last `keepRounds`
 * assistant messages with a short head plus a note. Returns the input array
 * untouched when nothing qualifies; never mutates the messages it is given
 * (they are the agent's live state).
 */
export function pruneStaleToolResults<T>(messages: T[], keepRounds = KEEP_RECENT_ROUNDS): T[] {
  let seen = 0;
  let boundary = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if ((messages[i] as { role?: unknown } | undefined)?.role === "assistant" && ++seen === keepRounds) {
      boundary = i;
      break;
    }
  }
  if (boundary <= 0) return messages;

  let out: T[] | null = null;
  for (let i = 0; i < boundary; i++) {
    const message = messages[i];
    if (!isToolResult(message)) continue;
    const chars = contentChars(message.content);
    if (chars < PRUNE_MIN_CHARS) continue;

    const text = message.content
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("\n");
    const head = text.slice(0, PRUNE_HEAD_CHARS).trimEnd();
    const note =
      `[${message.toolName ?? "tool"} output trimmed from context: ~${Math.round(chars / 4).toLocaleString("en-US")} tokens, ` +
      "several steps old. Re-run the tool if you need the full result again.]";
    out ??= messages.slice();
    out[i] = {
      ...message,
      content: [{ type: "text", text: head ? `${head}\n…\n${note}` : note }],
    } as T;
  }
  return out ?? messages;
}
