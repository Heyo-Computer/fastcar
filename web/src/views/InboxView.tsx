import { useEffect } from "react";
import type { InboxItem } from "@fastcar/shared";
import { useStore } from "../state/store.ts";
import { navigate, type InboxFilter } from "../lib/router.ts";

/** "2m", "3h", "Sep 18" — enough to place a reply without reading a date. */
function ago(iso: string | null): string {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "now";
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function dayLabel(iso: string | null): string {
  if (!iso) return "No activity";
  const d = new Date(iso);
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.floor((start(new Date()) - start(d)) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return "This week";
  if (days < 30) return "This month";
  return "Earlier";
}

const SOURCE_BADGE: Record<string, string> = {
  schedule: "scheduled",
  prompt: "prompt",
  trigger: "triggered",
};

function Row({ item }: { item: InboxItem }) {
  return (
    <button
      onClick={() => navigate({ name: "thread", threadId: item.threadId })}
      className={
        "group flex w-full gap-3 border-b border-border/60 px-4 py-3 text-left hover:bg-panel-2/60 " +
        (item.unread ? "bg-panel-2/20" : "")
      }
    >
      <span
        className={
          "mt-1 h-2 w-2 shrink-0 rounded-full " +
          (item.needsYou ? "bg-warn" : item.unread ? "bg-accent" : "bg-transparent")
        }
        title={item.needsYou ? "waiting for you" : item.unread ? "unread" : "read"}
      />
      <span className="mt-px shrink-0 text-base leading-none" aria-hidden>
        {item.agentAvatar ?? "🤖"}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span
            className={
              "shrink-0 text-[0.72rem] " + (item.unread ? "text-accent" : "text-ink-faint")
            }
          >
            {item.agentName}
          </span>
          <span
            className={
              "min-w-0 flex-1 truncate text-sm " +
              (item.unread ? "font-medium text-ink" : "text-ink-dim")
            }
          >
            {item.title}
          </span>
          <span className="shrink-0 text-[0.68rem] text-ink-faint">{ago(item.lastMessageAt)}</span>
        </span>
        <span className="mt-0.5 flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-[0.78rem] text-ink-faint">
            {item.error ? (
              <span className="text-danger">{item.error}</span>
            ) : (
              item.preview || <span className="italic">no reply yet</span>
            )}
          </span>
        </span>
        {(item.artifacts.length > 0 || SOURCE_BADGE[item.source] || item.needsYou) && (
          <span className="mt-1 flex flex-wrap items-center gap-1.5">
            {item.needsYou && (
              <span className="rounded border border-warn/40 px-1.5 py-px text-[0.62rem] uppercase tracking-wide text-warn">
                {item.status === "awaiting_approval" ? "approve plan" : "answer"}
              </span>
            )}
            {SOURCE_BADGE[item.source] && (
              <span className="rounded border border-border px-1.5 py-px text-[0.62rem] uppercase tracking-wide text-ink-faint">
                {SOURCE_BADGE[item.source]}
              </span>
            )}
            {item.artifacts.map((a) => (
              // Stops propagation so opening the artifact does not also open
              // the thread behind it.
              <a
                key={a.id}
                href={a.url}
                target="_blank"
                rel="noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="rounded border border-accent-dim/30 bg-accent-dim/10 px-1.5 py-px text-[0.62rem] text-accent hover:bg-accent-dim/20"
              >
                {a.name}
              </a>
            ))}
          </span>
        )}
      </span>
    </button>
  );
}

const FILTERS: Array<{ id: InboxFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "unread", label: "Unread" },
  { id: "needs_you", label: "Needs you" },
];

export function InboxView({ filter }: { filter: InboxFilter }) {
  const inbox = useStore((s) => s.inbox);
  const totalUnread = useStore((s) => s.totalUnread);
  const loadInbox = useStore((s) => s.loadInbox);

  useEffect(() => {
    void loadInbox();
  }, [loadInbox, filter]);

  // Filtered here rather than in a selector: a selector returning a fresh
  // array loops useSyncExternalStore (see ArtifactsPanel.tsx).
  const items =
    filter === "unread"
      ? inbox.filter((i) => i.unread)
      : filter === "needs_you"
        ? inbox.filter((i) => i.needsYou)
        : inbox;

  const groups: Array<{ label: string; items: InboxItem[] }> = [];
  for (const i of items) {
    const label = dayLabel(i.lastMessageAt);
    const g = groups.find((x) => x.label === label);
    if (g) g.items.push(i);
    else groups.push({ label, items: [i] });
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-center gap-3 border-b border-border bg-panel px-6 py-3">
        <h2 className="font-medium text-ink">Inbox</h2>
        {totalUnread > 0 && (
          <span className="rounded-full bg-accent-dim/20 px-2 py-px text-[0.68rem] text-accent">
            {totalUnread} unread
          </span>
        )}
        <div className="ml-auto flex gap-1">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              onClick={() => navigate({ name: "inbox", filter: f.id })}
              className={
                "rounded-lg px-2.5 py-1 text-[0.72rem] " +
                (filter === f.id
                  ? "bg-panel-2 text-ink"
                  : "text-ink-faint hover:bg-panel-2/60 hover:text-ink-dim")
              }
            >
              {f.label}
            </button>
          ))}
          {totalUnread > 0 && (
            <button
              onClick={async () => {
                await fetch("/api/inbox/read-all", { method: "POST" });
                void useStore.getState().loadInbox();
              }}
              className="ml-1 rounded-lg border border-border px-2.5 py-1 text-[0.72rem] text-ink-faint hover:bg-panel-2 hover:text-ink"
            >
              Mark all read
            </button>
          )}
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {groups.map((g) => (
          <div key={g.label}>
            <div className="sticky top-0 z-10 bg-bg/95 px-4 pt-3 pb-1 text-[0.68rem] font-medium uppercase tracking-wider text-ink-faint backdrop-blur">
              {g.label}
            </div>
            {g.items.map((i) => (
              <Row key={i.threadId} item={i} />
            ))}
          </div>
        ))}
        {!items.length && (
          <div className="flex flex-col items-center justify-center gap-2 py-20 text-ink-faint">
            <span className="text-3xl">📥</span>
            <p className="text-sm">
              {filter === "all" ? "Nothing here yet." : `No ${filter.replace("_", " ")} threads.`}
            </p>
            {filter === "all" && (
              <p className="max-w-xs text-center text-[0.78rem]">
                Agent replies land here — including runs your schedules fire overnight.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
