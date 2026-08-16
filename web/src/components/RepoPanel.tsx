import { useState } from "react";
import type { RepoStatus } from "@fastcar/shared";
import { useStore } from "../state/store.ts";
import { send } from "../lib/ws.ts";

/** Compact age of the last commit — how you spot a stale clone. */
function age(iso: string | undefined): string {
  if (!iso) return "—";
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (!Number.isFinite(days)) return "—";
  if (days <= 0) return "today";
  if (days < 30) return `${days}d`;
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  return `${Math.floor(days / 365)}y`;
}

export function RepoPanel() {
  const repos = useStore((s) => s.repos);
  const selectedId = useStore((s) => s.selectedId);
  const [adding, setAdding] = useState(false);
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [token, setToken] = useState("");
  /** Repo awaiting purge confirmation. */
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  /** Why the server refused the last purge — offers the force retry. */
  const [refusal, setRefusal] = useState<{ name: string; message: string } | null>(null);

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

  const purge = async (repo: string, force = false) => {
    setBusy(repo);
    setRefusal(null);
    try {
      const res = await fetch(`/api/repos/${encodeURIComponent(repo)}${force ? "?force=1" : ""}`, {
        method: "DELETE",
      });
      if (res.ok) {
        setConfirming(null);
        // The server also broadcasts repos_updated; refresh in case the socket is down.
        void useStore.getState().loadRepos();
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setRefusal({ name: repo, message: body.error ?? `purge failed (${res.status})` });
    } catch (err) {
      setRefusal({ name: repo, message: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  };

  const startPurge = (repo: RepoStatus) => {
    setRefusal(null);
    setConfirming(confirming === repo.name ? null : repo.name);
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
          <div key={r.name}>
            <div
              title={`${r.url}\n${r.path}${r.lastCommitAt ? `\nlast commit ${new Date(r.lastCommitAt).toLocaleString()}` : ""}`}
              className="group flex items-center gap-2 rounded-lg px-2 py-1.5 text-[0.78rem] text-ink-dim hover:bg-panel-2/60"
            >
              <span className="shrink-0">{r.missing ? "⚠️" : "📦"}</span>
              <span className="truncate text-ink">{r.name}</span>
              <span className="ml-auto flex shrink-0 items-center gap-1 font-mono text-[0.68rem] text-ink-faint">
                {r.branch && <span>{r.branch}</span>}
                {r.dirty && <span className="text-warn" title="uncommitted changes">●</span>}
                {(r.ahead ?? 0) > 0 && <span className="text-accent">↑{r.ahead}</span>}
                {(r.behind ?? 0) > 0 && <span className="text-warn">↓{r.behind}</span>}
                <span title="age of the last commit">{age(r.lastCommitAt)}</span>
              </span>
              <button
                onClick={() => startPurge(r)}
                disabled={busy === r.name}
                title="Purge: delete this clone from the VM and deregister it"
                className={`shrink-0 rounded px-1 text-sm text-ink-faint hover:bg-panel hover:text-danger disabled:opacity-40 ${
                  confirming === r.name ? "text-danger" : "opacity-0 group-hover:opacity-100"
                }`}
              >
                ×
              </button>
            </div>

            {confirming === r.name && (
              <div className="mb-1 ml-2 mr-2 rounded-lg border border-danger/30 bg-danger/5 px-2.5 py-2 text-[0.72rem]">
                {refusal?.name === r.name ? (
                  <p className="text-warn">{refusal.message}</p>
                ) : (
                  <p className="text-ink-dim">
                    Delete <span className="text-ink">{r.path}</span> and deregister it? This cannot
                    be undone.
                  </p>
                )}
                <div className="mt-1.5 flex gap-1.5">
                  <button
                    onClick={() => void purge(r.name, refusal?.name === r.name)}
                    disabled={busy === r.name}
                    className="rounded border border-danger/50 bg-danger/10 px-2 py-0.5 text-danger hover:bg-danger/20 disabled:opacity-40"
                  >
                    {busy === r.name
                      ? "Purging…"
                      : refusal?.name === r.name
                        ? "Purge anyway"
                        : "Purge"}
                  </button>
                  <button
                    onClick={() => {
                      setConfirming(null);
                      setRefusal(null);
                    }}
                    className="rounded border border-border px-2 py-0.5 text-ink-dim hover:bg-panel-2"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
        {!repos.length && !adding && (
          <p className="px-2 py-1 text-[0.72rem] text-ink-faint">No repositories yet — add one.</p>
        )}
      </div>
    </div>
  );
}
