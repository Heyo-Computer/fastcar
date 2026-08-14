import { useState } from "react";
import type { ChatItem } from "../state/store.ts";
import { send } from "../lib/ws.ts";

export function QuestionCard({
  item,
  threadId,
  active,
}: {
  item: Extract<ChatItem, { type: "question" }>;
  threadId: string;
  active: boolean;
}) {
  const [text, setText] = useState("");
  const answer = (value: string) => {
    if (!value.trim()) return;
    send({ type: "answer_question", threadId, questionId: item.questionId, answer: value.trim() });
  };

  return (
    <div className="my-2 rounded-lg border border-warn/40 bg-warn/5 p-3">
      <div className="mb-2 flex items-center gap-2 text-[0.7rem] font-medium uppercase tracking-wider text-warn">
        ❓ The agent asks
      </div>
      <p className="text-sm text-ink">{item.prompt}</p>

      {item.answer ? (
        <p className="mt-2 text-sm text-ink-dim">
          <span className="text-ink-faint">You answered:</span> {item.answer}
        </p>
      ) : active ? (
        <div className="mt-3 space-y-2">
          {item.options && item.options.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {item.options.map((opt) => (
                <button
                  key={opt}
                  onClick={() => answer(opt)}
                  className="rounded-lg border border-warn/40 px-3 py-1 text-sm text-ink hover:bg-warn/10"
                >
                  {opt}
                </button>
              ))}
            </div>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              answer(text);
            }}
            className="flex gap-2"
          >
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Type an answer…"
              className="flex-1 rounded-lg border border-border bg-panel px-3 py-1.5 text-sm text-ink outline-none focus:border-warn/60"
            />
            <button
              type="submit"
              className="rounded-lg border border-warn/40 px-3 py-1.5 text-sm text-warn hover:bg-warn/10"
            >
              Answer
            </button>
          </form>
        </div>
      ) : (
        <p className="mt-2 text-xs text-ink-faint">(no longer awaiting an answer)</p>
      )}
    </div>
  );
}
