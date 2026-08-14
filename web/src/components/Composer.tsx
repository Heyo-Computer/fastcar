import { useRef, useState } from "react";
import type { ThreadMeta } from "@fastcar/shared";
import { send } from "../lib/ws.ts";
import { useMicRecorder } from "../hooks/useMicRecorder.ts";

export function Composer({ thread }: { thread: ThreadMeta }) {
  const [text, setText] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mic = useMicRecorder();

  const busy = thread.status !== "idle";
  const running = thread.status === "running";

  const submit = () => {
    const value = text.trim();
    if (!value) return;
    if (running) {
      send({ type: "steer", threadId: thread.id, text: value });
    } else if (thread.status === "idle") {
      send({ type: "prompt", threadId: thread.id, text: value });
    } else {
      return; // awaiting question/plan — answer via the card
    }
    setText("");
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

  const hint =
    thread.status === "awaiting_input"
      ? "Answer the agent's question above to continue"
      : thread.status === "awaiting_approval"
        ? "Review the proposed plan above"
        : running
          ? "Agent is working — messages will steer it"
          : thread.mode === "plan"
            ? "Describe the task to plan"
            : "Message the agent";

  return (
    <div className="border-t border-border bg-panel px-6 py-3">
      <div className="mx-auto max-w-3xl">
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
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
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
                disabled={!text.trim() || thread.status === "awaiting_input" || thread.status === "awaiting_approval"}
                className="rounded-lg bg-accent-dim/20 border border-accent-dim/50 px-4 py-1 text-[0.78rem] font-medium text-accent hover:bg-accent-dim/30 disabled:opacity-40"
              >
                {running ? "Steer" : "Send"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
