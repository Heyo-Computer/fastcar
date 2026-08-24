import { useState } from "react";
import type { McpServerStatus } from "@fastcar/shared";
import { useStore } from "../state/store.ts";

const DOT: Record<McpServerStatus["status"], string> = {
  connected: "bg-accent",
  stopped: "bg-ink-faint",
  error: "bg-danger",
};

/** "KEY=value" lines → map; blank lines and comments ignored. */
function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

export function McpPanel() {
  const servers = useStore((s) => s.mcpServers);
  const [adding, setAdding] = useState(false);
  const [source, setSource] = useState("");
  const [name, setName] = useState("");
  const [env, setEnv] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  const install = async () => {
    const trimmed = source.trim();
    if (!trimmed) return;
    setBusy("__install");
    setError(null);
    try {
      const res = await fetch("/api/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: trimmed, name: name.trim() || undefined, env: parseEnv(env) }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `install failed (${res.status})`);
        return;
      }
      setSource("");
      setName("");
      setEnv("");
      setAdding(false);
      // The server also broadcasts mcp_servers_updated; refresh in case the socket is down.
      void useStore.getState().loadMcpServers();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (server: string) => {
    setBusy(server);
    setError(null);
    try {
      const res = await fetch(`/api/mcp/${encodeURIComponent(server)}`, { method: "DELETE" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `remove failed (${res.status})`);
        return;
      }
      setConfirming(null);
      void useStore.getState().loadMcpServers();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="border-t border-border">
      <div className="flex items-center px-4 pt-3 pb-1">
        <span className="text-[0.7rem] font-medium uppercase tracking-wider text-ink-faint">
          MCP servers
        </span>
        <button
          onClick={() => setAdding(!adding)}
          title="Install an MCP server from a GitHub URL"
          className="ml-auto rounded px-1.5 text-sm text-ink-faint hover:bg-panel-2 hover:text-accent"
        >
          {adding ? "×" : "+"}
        </button>
      </div>

      {adding && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void install();
          }}
          className="space-y-1.5 px-3 pb-2"
        >
          <input
            value={source}
            onChange={(e) => setSource(e.target.value)}
            placeholder="https://github.com/org/repo/tree/main/mcp"
            autoFocus
            className="w-full rounded-lg border border-border bg-panel-2 px-2.5 py-1.5 text-[0.78rem] text-ink outline-none focus:border-accent/60"
          />
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="name (optional)"
            className="w-full rounded-lg border border-border bg-panel-2 px-2.5 py-1.5 text-[0.78rem] text-ink outline-none focus:border-accent/60"
          />
          <textarea
            value={env}
            onChange={(e) => setEnv(e.target.value)}
            placeholder={"env, one per line:\nAPI_URL=https://…\nAPI_TOKEN=…"}
            rows={3}
            className="w-full resize-y rounded-lg border border-border bg-panel-2 px-2.5 py-1.5 font-mono text-[0.72rem] text-ink outline-none focus:border-accent/60"
          />
          <div className="flex items-center gap-1.5">
            <button
              type="submit"
              disabled={!source.trim() || busy === "__install"}
              className="rounded-lg border border-accent-dim/50 bg-accent-dim/20 px-3 py-1.5 text-[0.78rem] text-accent hover:bg-accent-dim/30 disabled:opacity-40"
            >
              {busy === "__install" ? "Installing…" : "Install"}
            </button>
            <span className="text-[0.65rem] text-ink-faint">Clones, builds and starts it. Env is stored encrypted.</span>
          </div>
        </form>
      )}

      {error && <p className="px-4 pb-1 text-[0.7rem] text-warn">{error}</p>}

      <div className="max-h-48 overflow-y-auto px-2 pb-3">
        {servers.map((s) => (
          <div key={s.name}>
            <div
              title={[
                s.source,
                s.path ?? s.url ?? "",
                s.error ?? "",
                s.tools.length ? `tools: ${s.tools.map((t) => t.name).join(", ")}` : "no tools advertised",
              ]
                .filter(Boolean)
                .join("\n")}
              className="group flex items-center gap-2 rounded-lg px-2 py-1.5 text-[0.78rem] text-ink-dim hover:bg-panel-2/60"
            >
              <span className={`h-2 w-2 shrink-0 rounded-full ${DOT[s.status]}`} title={s.status} />
              <span className="truncate text-ink">{s.name}</span>
              <span className="ml-auto flex shrink-0 items-center gap-1 font-mono text-[0.68rem] text-ink-faint">
                <span>{s.transport}</span>
                <span title="tools">{s.tools.length}🔧</span>
              </span>
              <button
                onClick={() => setConfirming(confirming === s.name ? null : s.name)}
                disabled={busy === s.name}
                title="Remove: stop the server and delete its install"
                className={`shrink-0 rounded px-1 text-sm text-ink-faint hover:bg-panel hover:text-danger disabled:opacity-40 ${
                  confirming === s.name ? "text-danger" : "opacity-0 group-hover:opacity-100"
                }`}
              >
                ×
              </button>
            </div>
            {confirming === s.name && (
              <div className="mb-1 ml-2 mr-2 rounded-lg border border-danger/30 bg-danger/5 px-2.5 py-2 text-[0.72rem]">
                <p className="text-ink-dim">
                  Stop <span className="text-ink">{s.name}</span>
                  {s.path ? " and delete its install directory" : ""}?
                </p>
                <div className="mt-1.5 flex gap-1.5">
                  <button
                    onClick={() => void remove(s.name)}
                    disabled={busy === s.name}
                    className="rounded border border-danger/50 bg-danger/10 px-2 py-0.5 text-danger hover:bg-danger/20 disabled:opacity-40"
                  >
                    {busy === s.name ? "Removing…" : "Remove"}
                  </button>
                  <button
                    onClick={() => setConfirming(null)}
                    className="rounded border border-border px-2 py-0.5 text-ink-dim hover:bg-panel-2"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
        {!servers.length && !adding && (
          <p className="px-2 py-1 text-[0.72rem] text-ink-faint">
            None installed — paste a GitHub URL, or ask the agent.
          </p>
        )}
      </div>
    </div>
  );
}
