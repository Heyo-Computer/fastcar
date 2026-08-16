import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CommandSpec, ThreadMeta } from "@fastcar/shared";
import { send } from "../lib/ws.ts";
import { useMicRecorder } from "../hooks/useMicRecorder.ts";
import { useStore } from "../state/store.ts";
import {
  applyCompletion,
  completionFor,
  detectTrigger,
  fetchMentions,
  filterCommands,
  matchCommand,
  type Suggestion,
  type Trigger,
} from "../lib/suggestions.ts";
import { SuggestionMenu } from "./SuggestionMenu.tsx";

const MENTION_DEBOUNCE_MS = 90;

export function Composer({ thread }: { thread: ThreadMeta }) {
  const [text, setText] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mic = useMicRecorder();
  const commands = useStore((s) => s.commands);

  const [trigger, setTrigger] = useState<Trigger | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [active, setActive] = useState(0);
  /** Text the menu was dismissed at — typing anything else re-opens it. */
  const dismissedAt = useRef<string | null>(null);
  /** Caret position to restore after a completion rewrites the text. */
  const pendingCaret = useRef<number | null>(null);

  const busy = thread.status !== "idle";
  const running = thread.status === "running";
  const command = useMemo(() => matchCommand(text, commands), [text, commands]);
  const menuOpen = trigger !== null && suggestions.length > 0;
  /** Server commands act on the thread, so they wait for it; `/new` does not. */
  const needsIdle = command?.spec.scope === "server" && busy;

  // ------------------------------------------------------------- suggestions

  const refreshTrigger = (el: HTMLTextAreaElement) => {
    const value = el.value;
    if (dismissedAt.current !== null && dismissedAt.current === value) return;
    dismissedAt.current = null;
    const next = detectTrigger(value, el.selectionStart ?? value.length);
    // Keep the same object when nothing changed — a caret move must not
    // re-run the effect below and refetch on every keystroke.
    setTrigger((prev) =>
      prev && next && prev.kind === next.kind && prev.start === next.start && prev.query === next.query
        ? prev
        : next,
    );
  };

  useEffect(() => {
    if (!trigger) {
      setSuggestions([]);
      return;
    }
    setActive(0);
    if (trigger.kind === "command") {
      setSuggestions(
        filterCommands(commands, trigger.query).map((spec) => ({ kind: "command", spec })),
      );
      return;
    }
    // Drop entries from a different trigger while the fetch is in flight, so a
    // keystroke can never accept something the popup is merely still showing.
    setSuggestions((prev) => (prev.every((s) => s.kind === "mention") ? prev : []));
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void fetchMentions(trigger.query, controller.signal)
        .then((items) => setSuggestions(items.map((item) => ({ kind: "mention", item }))))
        .catch(() => {
          /* superseded or offline */
        });
    }, MENTION_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [trigger, commands]);

  useLayoutEffect(() => {
    if (pendingCaret.current === null) return;
    const el = textareaRef.current;
    if (el) {
      el.focus();
      el.setSelectionRange(pendingCaret.current, pendingCaret.current);
    }
    pendingCaret.current = null;
  });

  const accept = (suggestion: Suggestion) => {
    const el = textareaRef.current;
    if (!el || !trigger) return;
    const caret = el.selectionStart ?? text.length;
    const next = applyCompletion(text, caret, trigger, completionFor(suggestion));
    setText(next.text);
    pendingCaret.current = next.caret;
    // Accepting a directory continues the same mention; everything else is done.
    setTrigger(detectTrigger(next.text, next.caret));
  };

  const dismiss = () => {
    dismissedAt.current = text;
    setTrigger(null);
  };

  // ------------------------------------------------------------- sending

  const runCommand = (spec: CommandSpec, args: string) => {
    if (spec.scope === "client") {
      if (spec.name === "new") {
        useStore.setState({ awaitingCreatedThread: true });
        send({ type: "create_thread", mode: args.toLowerCase().startsWith("plan") ? "plan" : "act" });
      }
      return;
    }
    send({ type: "command", threadId: thread.id, name: spec.name, args });
  };

  const submit = () => {
    const value = text.trim();
    if (!value) return;
    if (command) {
      if (needsIdle) return;
      runCommand(command.spec, command.args);
    } else if (running) {
      send({ type: "steer", threadId: thread.id, text: value });
    } else if (thread.status === "idle") {
      send({ type: "prompt", threadId: thread.id, text: value });
    } else {
      return; // awaiting question/plan — answer via the card
    }
    setText("");
    setTrigger(null);
    dismissedAt.current = null;
  };

  const attachMarkdown = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const content = String(reader.result ?? "");
      const prompt = `The user provided this task file (${file.name}):\n\n${content}`;
      send({ type: "prompt", threadId: thread.id, text: prompt });
    };
    reader.readAsText(file);
  };

  const toggleMic = async () => {
    if (mic.recording) {
      const transcript = await mic.stop();
      if (transcript) {
        setText((t) => (t ? `${t} ${transcript}` : transcript));
        textareaRef.current?.focus();
      }
    } else {
      await mic.start().catch(() => {});
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (menuOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((i) => (i + 1) % suggestions.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((i) => (i - 1 + suggestions.length) % suggestions.length);
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        // `active` can outrun the list when a fetch lands between keystrokes.
        accept(suggestions[Math.min(active, suggestions.length - 1)]!);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        dismiss();
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const hint =
    thread.status === "awaiting_input"
      ? "Answer the agent's question above to continue"
      : thread.status === "awaiting_approval"
        ? "Review the proposed plan above"
        : running
          ? "Agent is working — messages will steer it"
          : thread.mode === "plan"
            ? "Describe the task to plan — / for commands, @ to reference files"
            : "Message the agent — / for commands, @ to reference files";

  const sendLabel = command ? "Run" : running ? "Steer" : "Send";
  const sendDisabled =
    !text.trim() ||
    (command
      ? needsIdle
      : thread.status === "awaiting_input" || thread.status === "awaiting_approval");

  return (
    <div className="border-t border-border bg-panel px-6 py-3">
      <div className="relative mx-auto max-w-3xl">
        {menuOpen && (
          <SuggestionMenu
            suggestions={suggestions}
            active={active}
            onPick={accept}
            onHover={setActive}
          />
        )}
        <div
          className="rounded-xl border border-border bg-panel-2 focus-within:border-accent/50"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const file = e.dataTransfer.files[0];
            if (file && (file.name.endsWith(".md") || file.type === "text/markdown"))
              attachMarkdown(file);
          }}
        >
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              refreshTrigger(e.target);
            }}
            onSelect={(e) => refreshTrigger(e.currentTarget)}
            onBlur={() => setTrigger(null)}
            onKeyDown={onKeyDown}
            placeholder={hint}
            rows={Math.min(8, Math.max(1, text.split("\n").length))}
            className="w-full resize-none bg-transparent px-4 pt-3 pb-1 text-[0.925rem] text-ink outline-none placeholder:text-ink-faint"
          />
          <div className="flex items-center gap-1.5 px-2.5 pb-2">
            {/* Mode toggle */}
            <div className="flex overflow-hidden rounded-lg border border-border text-[0.72rem]">
              {(["act", "plan"] as const).map((m) => (
                <button
                  key={m}
                  disabled={busy || thread.mode === m}
                  onClick={() => send({ type: "set_mode", threadId: thread.id, mode: m })}
                  title={busy ? "Mode can change when the agent is idle" : `Switch to ${m} mode`}
                  className={`px-2.5 py-1 uppercase tracking-wide ${
                    thread.mode === m
                      ? m === "plan"
                        ? "bg-warn/20 text-warn"
                        : "bg-accent-dim/20 text-accent"
                      : "text-ink-faint hover:text-ink-dim disabled:opacity-50"
                  }`}
                >
                  {m}
                </button>
              ))}
            </div>

            {/* Markdown attach */}
            <input
              ref={fileInputRef}
              type="file"
              accept=".md,text/markdown"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) attachMarkdown(file);
                e.target.value = "";
              }}
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={busy}
              title="Attach a markdown task file"
              className="rounded-lg px-2 py-1 text-sm text-ink-faint hover:bg-panel hover:text-ink-dim disabled:opacity-40"
            >
              📎
            </button>

            {/* Mic */}
            <button
              onClick={() => void toggleMic()}
              disabled={mic.transcribing}
              title={mic.recording ? "Stop and transcribe" : "Record a voice prompt"}
              className={`rounded-lg px-2 py-1 text-sm ${
                mic.recording
                  ? "bg-danger/20 text-danger animate-pulse"
                  : mic.transcribing
                    ? "text-warn animate-pulse"
                    : "text-ink-faint hover:bg-panel hover:text-ink-dim"
              }`}
            >
              {mic.transcribing ? "⏳" : "🎙️"}
            </button>
            {mic.error && <span className="text-[0.7rem] text-danger">{mic.error}</span>}

            <div className="ml-auto flex items-center gap-2">
              {command && (
                <span className="text-[0.7rem] text-ink-faint">
                  {needsIdle ? "this command runs when the agent is idle" : command.spec.summary}
                </span>
              )}
              {running && (
                <button
                  onClick={() => send({ type: "abort", threadId: thread.id })}
                  className="rounded-lg border border-danger/40 px-3 py-1 text-[0.78rem] text-danger hover:bg-danger/10"
                >
                  ◼ Stop
                </button>
              )}
              <button
                onClick={submit}
                disabled={sendDisabled}
                className="rounded-lg bg-accent-dim/20 border border-accent-dim/50 px-4 py-1 text-[0.78rem] font-medium text-accent hover:bg-accent-dim/30 disabled:opacity-40"
              >
                {sendLabel}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
