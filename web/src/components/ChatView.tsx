import { useEffect, useRef } from "react";
import type { ThreadMeta } from "@fastcar/shared";
import { useStore } from "../state/store.ts";
import { AssistantBubble, ErrorBubble, UserBubble } from "./MessageBubble.tsx";
import { PlanApprovalCard } from "./PlanApprovalCard.tsx";
import { QuestionCard } from "./QuestionCard.tsx";
import { ToolCallCard } from "./ToolCallCard.tsx";

export function ChatView({ thread }: { thread: ThreadMeta }) {
  const chat = useStore((s) => s.chats[thread.id]);
  const pending = useStore((s) => s.pending[thread.id]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  });

  const items = chat?.items ?? [];
  const lastPlanKey = [...items].reverse().find((i) => i.type === "plan")?.key;

  return (
    <div
      ref={scrollRef}
      onScroll={(e) => {
        const el = e.currentTarget;
        stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
      className="flex-1 overflow-y-auto px-6 py-4"
    >
      <div className="mx-auto max-w-3xl">
        {!chat?.loaded && <p className="py-8 text-center text-sm text-ink-faint">Loading…</p>}
        {chat?.loaded && !items.length && (
          <div className="py-16 text-center text-ink-faint">
            <p className="text-2xl">🏎️</p>
            <p className="mt-2 text-sm">
              {thread.mode === "plan"
                ? "Describe the task — the agent will explore and propose a plan for approval."
                : "Describe a task, or attach a markdown task file below."}
            </p>
          </div>
        )}

        {items.map((item) => {
          switch (item.type) {
            case "user":
              return <UserBubble key={item.key} item={item} />;
            case "assistant":
              return <AssistantBubble key={item.key} item={item} />;
            case "tool":
              return <ToolCallCard key={item.key} item={item} />;
            case "question":
              return (
                <QuestionCard
                  key={item.key}
                  item={item}
                  threadId={thread.id}
                  active={
                    thread.status === "awaiting_input" &&
                    pending?.kind === "question" &&
                    pending.questionId === item.questionId
                  }
                />
              );
            case "plan":
              return (
                <PlanApprovalCard
                  key={item.key}
                  planMarkdown={item.planMarkdown}
                  threadId={thread.id}
                  active={thread.status === "awaiting_approval" && item.key === lastPlanKey}
                />
              );
            case "error":
              return <ErrorBubble key={item.key} item={item} />;
          }
        })}

        {/* A pending question/plan restored from the server that isn't in the
            event list yet (e.g. fresh page load mid-interaction). */}
        {thread.status === "awaiting_input" &&
          pending?.kind === "question" &&
          !items.some((i) => i.type === "question" && i.questionId === pending.questionId) && (
            <QuestionCard
              item={{ type: "question", key: "pending-q", ...pending }}
              threadId={thread.id}
              active
            />
          )}
        {thread.status === "awaiting_approval" &&
          pending?.kind === "plan" &&
          !items.some((i) => i.type === "plan") && (
            <PlanApprovalCard planMarkdown={pending.planMarkdown} threadId={thread.id} active />
          )}
      </div>
    </div>
  );
}
