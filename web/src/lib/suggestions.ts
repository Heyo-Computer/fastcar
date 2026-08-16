/**
 * Composer autocomplete: what is being triggered at the caret, which entries
 * match, and how accepting one rewrites the text.
 *
 * `/` opens the command menu and is only a trigger at the very start of the
 * message — a command is the whole message. `@` opens the mention menu wherever
 * a word can start.
 */
import type { CommandSpec, MentionItem, MentionsResponse, CommandsResponse } from "@fastcar/shared";

export interface Trigger {
  kind: "command" | "mention";
  /** Index of the trigger character ("/" or "@") in the text. */
  start: number;
  /** Text typed between the trigger character and the caret. */
  query: string;
}

export type Suggestion =
  | { kind: "command"; spec: CommandSpec }
  | { kind: "mention"; item: MentionItem };

export function suggestionKey(s: Suggestion): string {
  return s.kind === "command" ? `c:${s.spec.name}` : `m:${s.item.kind}:${s.item.value}`;
}

/** The open trigger at `caret`, or null when the caret is in ordinary prose. */
export function detectTrigger(text: string, caret: number): Trigger | null {
  const before = text.slice(0, caret);

  if (before.startsWith("/") && !/\s/.test(before)) {
    return { kind: "command", start: 0, query: before.slice(1) };
  }

  const at = before.lastIndexOf("@");
  if (at !== -1) {
    const query = before.slice(at + 1);
    const preceding = at === 0 ? " " : before[at - 1]!;
    if (/\s/.test(preceding) && !/[\s@]/.test(query)) {
      return { kind: "mention", start: at, query };
    }
  }
  return null;
}

/** Text to insert (trigger character included) when a suggestion is accepted. */
export function completionFor(s: Suggestion): string {
  if (s.kind === "command") return `/${s.spec.name} `;
  // Directories keep the menu open so the next path segment can be typed.
  return `@${s.item.value}${s.item.kind === "dir" ? "/" : " "}`;
}

export function applyCompletion(
  text: string,
  caret: number,
  trigger: Trigger,
  insert: string,
): { text: string; caret: number } {
  const head = text.slice(0, trigger.start);
  const tail = text.slice(caret);
  return { text: head + insert + tail, caret: head.length + insert.length };
}

// ---------------------------------------------------------------- commands

function commandNames(spec: CommandSpec): string[] {
  return [spec.name, ...(spec.aliases ?? [])];
}

/** Prefix matches first, then substring matches; the menu stays short. */
export function filterCommands(commands: CommandSpec[], query: string): CommandSpec[] {
  const q = query.toLowerCase();
  if (!q) return commands;
  const scored: Array<{ spec: CommandSpec; rank: number }> = [];
  for (const spec of commands) {
    const names = commandNames(spec);
    if (names.some((n) => n.startsWith(q))) scored.push({ spec, rank: 0 });
    else if (names.some((n) => n.includes(q))) scored.push({ spec, rank: 1 });
    else if (spec.summary.toLowerCase().includes(q)) scored.push({ spec, rank: 2 });
  }
  return scored
    .sort((a, b) => a.rank - b.rank || a.spec.name.localeCompare(b.spec.name))
    .map((s) => s.spec);
}

/** Resolve submitted text to a command, including aliases. Null if it is prose. */
export function matchCommand(
  text: string,
  commands: CommandSpec[],
): { spec: CommandSpec; args: string } | null {
  const match = /^\/([a-z?][\w-]*)\s*([\s\S]*)$/i.exec(text.trim());
  if (!match) return null;
  const key = match[1]!.toLowerCase();
  const spec = commands.find((c) => commandNames(c).includes(key));
  return spec ? { spec, args: match[2]!.trim() } : null;
}

// ---------------------------------------------------------------- fetching

export async function fetchCommands(): Promise<CommandSpec[]> {
  const res = await fetch("/api/commands");
  if (!res.ok) return [];
  return ((await res.json()) as CommandsResponse).commands;
}

export async function fetchMentions(query: string, signal: AbortSignal): Promise<MentionItem[]> {
  const res = await fetch(`/api/mentions?q=${encodeURIComponent(query)}`, { signal });
  if (!res.ok) return [];
  return ((await res.json()) as MentionsResponse).items;
}
