import { useState } from "react";
import { useStore } from "../state/store.ts";
import { send } from "../lib/ws.ts";

export function RepoPanel() {
  const repos = useStore((s) => s.repos);
  const selectedId = useStore((s) => s.selectedId);
  const [adding, setAdding] = useState(false);
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [token, setToken] = useState("");

  const submit = () => {
    const trimmedUrl = url.trim();
    if (!trimmedUrl) return;
    // If a token is provided, embed it into the HTTPS URL for private repo access.
    let finalUrl = trimmedUrl;
    const trimmedToken = token.trim();
    if (trimmedToken && finalUrl.startsWith("https://")) {
      // Insert token as username: https://<token>@github.com/...
      finalUrl = "https://" + trimmedToken + "@" + finalUrl.slice(8);
    }
    // Routed through the conductor: it clones with git_clone in a visible thread.
    useStore.setState({ awaitingCreatedThread: true });
    send({
      type: "add_repo",
      url: finalUrl,
      name: name.trim() || undefined,
      threadId: selectedId ?? undefined,
    });
    setUrl("");
    setName("");
    setToken("");
    setAdding(false);
  };

  return (
    <div className="border-t border-border">
      <div className="flex items-center px-4 pt-3 pb-1">
        <span className="text-[0.7rem] font-medium uppercase tracking-wider text-ink-faint">
          Repositories
        </span>
        <button
          onClick={() => setAdding(!adding)}
          title="Ask the agent to clone a repository into the VM"
          className="ml-auto rounded px-1.5 text-sm text-ink-faint hover:bg-panel-2 hover:text-accent"
        >
          {adding ? "×" : "+"}
        </button>
      </div>

      {adding && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
          className="space-y-1.5 px-3 pb-2"
        >
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://… or git@… repo URL"
            autoFocus
            className="w-full rounded-lg border border-border bg-panel-2 px-2.5 py-1.5 text-[0.78rem] text-ink outline-none focus:border-accent/60"
          />
          <div className="flex gap-1.5">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="name (optional)"
              className="min-w-0 flex-1 rounded-lg border border-border bg-panel-2 px-2.5 py-1.5 text-[0.78rem] text-ink outline-none focus:border-accent/60"
            />
            <input
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="GitHub token (optional)"
              className="w-full rounded-lg border border-border bg-panel-2 px-2.5 py-1.5 text-[0.78rem] text-ink outline-none focus:border-accent/60 mt-1"
            />
            <button
              type="submit"
              disabled={!url.trim()}
              className="rounded-lg border border-accent-dim/50 bg-accent-dim/20 px-3 py-1.5 text-[0.78rem] text-accent hover:bg-accent-dim/30 disabled:opacity-40"
            >
              Clone
            </button>
          </div>
          <p className="text-[0.65rem] text-ink-faint">
            The agent clones it in a thread — watch progress there.
          </p>
        </form>
      )}

      <div className="max-h-48 overflow-y-auto px-2 pb-3">
        {repos.map((r) => (
          <div
            key={r.name}
            title={`${r.url}\n${r.path}`}
            className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-[0.78rem] text-ink-dim hover:bg-panel-2/60"
          >
            <span className="shrink-0">{r.missing ? "⚠️" : "📦"}</span>
            <span className="truncate text-ink">{r.name}</span>
            <span className="ml-auto flex shrink-0 items-center gap-1 font-mono text-[0.68rem] text-ink-faint">
              {r.branch && <span>{r.branch}</span>}
              {r.dirty && <span className="text-warn" title="uncommitted changes">●</span>}
              {(r.ahead ?? 0) > 0 && <span className="text-accent">↑{r.ahead}</span>}
              {(r.behind ?? 0) > 0 && <span className="text-warn">↓{r.behind}</span>}
            </span>
          </div>
        ))}
        {!repos.length && !adding && (
          <p className="px-2 py-1 text-[0.72rem] text-ink-faint">No repositories yet — add one.</p>
        )}
      </div>
    </div>
  );
}
