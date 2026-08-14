import { useState } from "react";
import { send } from "../lib/ws.ts";
import { Markdown } from "./Markdown.tsx";

export function PlanApprovalCard({
  planMarkdown,
  threadId,
  active,
}: {
  planMarkdown: string;
  threadId: string;
  active: boolean;
}) {
  const [feedback, setFeedback] = useState("");
  const [showFeedback, setShowFeedback] = useState(false);

  return (
    <div className="my-2 rounded-lg border border-accent/40 bg-accent/5 p-3">
      <div className="mb-2 flex items-center gap-2 text-[0.7rem] font-medium uppercase tracking-wider text-accent">
        📋 Proposed plan
      </div>
      <div className="max-h-[26rem] overflow-y-auto rounded-md bg-panel/60 p-3">
        <Markdown text={planMarkdown} />
      </div>

      {active && (
        <div className="mt-3 space-y-2">
          <div className="flex gap-2">
            <button
              onClick={() => send({ type: "approve_plan", threadId })}
              className="rounded-lg bg-accent-dim/20 border border-accent-dim/50 px-4 py-1.5 text-sm font-medium text-accent hover:bg-accent-dim/30"
            >
              ✓ Approve & execute
            </button>
            <button
              onClick={() => setShowFeedback(!showFeedback)}
              className="rounded-lg border border-border px-4 py-1.5 text-sm text-ink-dim hover:bg-panel-2"
            >
              Request changes
            </button>
          </div>
          {showFeedback && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (!feedback.trim()) return;
                send({ type: "reject_plan", threadId, feedback: feedback.trim() });
                setFeedback("");
                setShowFeedback(false);
              }}
              className="flex gap-2"
            >
              <input
                value={feedback}
                onChange={(e) => setFeedback(e.target.value)}
                placeholder="What should change?"
                autoFocus
                className="flex-1 rounded-lg border border-border bg-panel px-3 py-1.5 text-sm text-ink outline-none focus:border-accent/60"
              />
              <button
                type="submit"
                className="rounded-lg border border-border px-3 py-1.5 text-sm text-ink-dim hover:bg-panel-2"
              >
                Send
              </button>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
