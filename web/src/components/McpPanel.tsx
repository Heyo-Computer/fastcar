import { useState } from "react";
import type { McpServerStatus } from "@fastcar/shared";
import { useStore } from "../state/store.ts";

const DOT: Record<McpServerStatus["status"], string> = {
  connected: "bg-accent",
  stopped: "bg-ink-faint",
  error: "bg-danger",
  needs_auth: "bg-warn",
};

const TRANSPORT_LABEL: Record<McpServerStatus["transport"], string> = {
  stdio: "local",
  http: "remote",
  sse: "remote·sse",
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

/**
 * "Header: value" lines → map, the way they look in curl or a provider's
 * docs. A bare token with no header name is taken as a bearer token, since
 * that is what people most often paste.
 */
function parseHeaders(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon > 0 && !/\s/.test(line.slice(0, colon))) {
      out[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
    } else {
      out.Authorization = /^bearer\s/i.test(line) ? line : `Bearer ${line}`;
    }
  }
  return out;
}

type Mode = "remote" | "code";

const field =
  "w-full rounded-lg border border-border bg-panel-2 px-2.5 py-1.5 text-[0.78rem] text-ink outline-none focus:border-accent/60";

/**
 * A server waiting on a sign-in. Rendered as a link the user clicks rather
 * than a window.open() after the install request returns: a popup opened
 * outside the original click is blocked by every major browser.
 */
function SignInPrompt({ server }: { server: McpServerStatus }) {
  if (!server.authorizationUrl) return null;
  return (
    <div className="mx-2 mb-2 rounded-lg border border-warn/40 bg-warn/5 px-3 py-2 text-[0.74rem]">
      <p className="text-ink-dim">
        <span className="text-ink">{server.name}</span> uses OAuth. Sign in with the provider to finish
        connecting — this page updates on its own once you have.
      </p>
      <a
        href={server.authorizationUrl}
        target="_blank"
        rel="noreferrer"
        className="mt-1.5 inline-block rounded border border-warn/50 bg-warn/10 px-2.5 py-1 text-warn hover:bg-warn/20"
      >
        Sign in to {server.name} ↗
      </a>
    </div>
  );
}

export function McpPanel() {
  const servers = useStore((s) => s.mcpServers);
  const [adding, setAdding] = useState(false);
  const [mode, setMode] = useState<Mode>("remote");
  const [source, setSource] = useState("");
  const [name, setName] = useState("");
  const [env, setEnv] = useState("");
  const [headers, setHeaders] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  /** A first install waiting on OAuth — not a registered server yet, so not in `servers`. */
  const [pendingSignIn, setPendingSignIn] = useState<McpServerStatus | null>(null);

  const install = async () => {
    const trimmed = source.trim();
    if (!trimmed) return;
    setBusy("__install");
    setError(null);
    try {
      const body =
        mode === "remote"
          ? { source: trimmed, name: name.trim() || undefined, headers: parseHeaders(headers) }
          : { source: trimmed, name: name.trim() || undefined, env: parseEnv(env), transport: "stdio" };
      const res = await fetch("/api/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; server?: McpServerStatus };
      if (!res.ok) {
        setError(data.error ?? `install failed (${res.status})`);
        return;
      }
      if (data.server?.status === "needs_auth") {
        // Nothing is registered until sign-in finishes; the callback page
        // tells the user they are connected, and mcp_servers_updated arrives.
        setPendingSignIn(data.server);
      } else {
        setPendingSignIn(null);
      }
      setSource("");
      setName("");
      setEnv("");
      setHeaders("");
      setAdding(false);
      void useStore.getState().loadMcpServers();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const reauthorize = async (server: string) => {
    setBusy(server);
    setError(null);
    try {
      const res = await fetch(`/api/mcp/${encodeURIComponent(server)}/authorize`, { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) setError(data.error ?? `could not start sign-in (${res.status})`);
      void useStore.getState().loadMcpServers();
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

  // The pending first install disappears once the real server row arrives.
  const pending = pendingSignIn && !servers.some((s) => s.name === pendingSignIn.name) ? pendingSignIn : null;

  return (
    <div className="border-t border-border">
      <div className="flex items-center px-4 pt-3 pb-1">
        <span className="text-[0.7rem] font-medium uppercase tracking-wider text-ink-faint">
          MCP servers
        </span>
        <button
          onClick={() => setAdding(!adding)}
          title="Connect a deployed MCP server, or install one from code"
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
          <div className="flex gap-1 pb-0.5">
            {(
              [
                ["remote", "Deployed server"],
                ["code", "Run from code"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setMode(id)}
                className={
                  "rounded-md px-2 py-0.5 text-[0.72rem] " +
                  (mode === id ? "bg-panel-2 text-ink" : "text-ink-faint hover:text-ink-dim")
                }
              >
                {label}
              </button>
            ))}
          </div>

          <input
            value={source}
            onChange={(e) => setSource(e.target.value)}
            placeholder={
              mode === "remote" ? "https://mcp.example.com/mcp" : "https://github.com/org/repo/tree/main/mcp"
            }
            autoFocus
            className={field}
          />
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="name (optional)"
            className={field}
          />
          {mode === "remote" ? (
            <textarea
              value={headers}
              onChange={(e) => setHeaders(e.target.value)}
              placeholder={
                "API key or headers, one per line (optional):\nAuthorization: Bearer sk-…\n\nLeave empty for OAuth — you'll be asked to sign in."
              }
              rows={3}
              className={field + " resize-y font-mono text-[0.72rem]"}
            />
          ) : (
            <textarea
              value={env}
              onChange={(e) => setEnv(e.target.value)}
              placeholder={"env, one per line:\nAPI_URL=https://…\nAPI_TOKEN=…"}
              rows={3}
              className={field + " resize-y font-mono text-[0.72rem]"}
            />
          )}
          <div className="flex items-center gap-1.5">
            <button
              type="submit"
              disabled={!source.trim() || busy === "__install"}
              className="rounded-lg border border-accent-dim/50 bg-accent-dim/20 px-3 py-1.5 text-[0.78rem] text-accent hover:bg-accent-dim/30 disabled:opacity-40"
            >
              {busy === "__install" ? "Connecting…" : mode === "remote" ? "Connect" : "Install"}
            </button>
            <span className="text-[0.65rem] text-ink-faint">
              {mode === "remote"
                ? "Speaks Streamable HTTP or SSE — detected for you. Keys are stored encrypted."
                : "Clones, builds and starts it. Env is stored encrypted."}
            </span>
          </div>
        </form>
      )}

      {error && <p className="px-4 pb-1 text-[0.7rem] text-warn">{error}</p>}
      {pending && <SignInPrompt server={pending} />}

      <div className="px-2 pb-3">
        {servers.map((s) => (
          <div key={s.name}>
            <div
              title={[
                s.source,
                s.path ?? s.url ?? "",
                s.error ?? "",
                s.headerKeys.length ? `headers: ${s.headerKeys.join(", ")}` : "",
                s.tools.length ? `tools: ${s.tools.map((t) => t.name).join(", ")}` : "no tools advertised",
              ]
                .filter(Boolean)
                .join("\n")}
              className="group flex items-center gap-2 rounded-lg px-2 py-1.5 text-[0.78rem] text-ink-dim hover:bg-panel-2/60"
            >
              <span className={`h-2 w-2 shrink-0 rounded-full ${DOT[s.status]}`} title={s.status.replace("_", " ")} />
              <span className="truncate text-ink">{s.name}</span>
              {s.auth !== "none" && (
                <span className="shrink-0 rounded border border-border px-1 text-[0.6rem] uppercase text-ink-faint">
                  {s.auth === "oauth" ? "oauth" : "key"}
                </span>
              )}
              <span className="ml-auto flex shrink-0 items-center gap-1.5 font-mono text-[0.68rem] text-ink-faint">
                <span>{TRANSPORT_LABEL[s.transport]}</span>
                <span title="tools">{s.tools.length}🔧</span>
              </span>
              {s.auth === "oauth" && s.status !== "needs_auth" && (
                <button
                  onClick={() => void reauthorize(s.name)}
                  disabled={busy === s.name}
                  title="Sign in again (e.g. after revoking access)"
                  className="shrink-0 rounded px-1 text-[0.7rem] text-ink-faint opacity-0 hover:bg-panel hover:text-ink group-hover:opacity-100 disabled:opacity-40"
                >
                  ↻
                </button>
              )}
              <button
                onClick={() => setConfirming(confirming === s.name ? null : s.name)}
                disabled={busy === s.name}
                title="Remove this server"
                className={`shrink-0 rounded px-1 text-sm text-ink-faint hover:bg-panel hover:text-danger disabled:opacity-40 ${
                  confirming === s.name ? "text-danger" : "opacity-0 group-hover:opacity-100"
                }`}
              >
                ×
              </button>
            </div>
            {s.status === "needs_auth" && <SignInPrompt server={s} />}
            {s.status === "error" && s.error && (
              <p className="mx-2 mb-1 truncate px-2 text-[0.68rem] text-danger" title={s.error}>
                {s.error}
              </p>
            )}
            {confirming === s.name && (
              <div className="mb-1 ml-2 mr-2 rounded-lg border border-danger/30 bg-danger/5 px-2.5 py-2 text-[0.72rem]">
                <p className="text-ink-dim">
                  {s.transport === "stdio" ? "Stop" : "Disconnect"} <span className="text-ink">{s.name}</span>
                  {s.path ? " and delete its install directory" : ""}
                  {s.auth === "oauth" ? " and forget its sign-in" : ""}?
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
        {!servers.length && !adding && !pending && (
          <p className="px-2 py-1 text-[0.72rem] text-ink-faint">
            None yet — connect a deployed server's URL, or ask the agent.
          </p>
        )}
      </div>
    </div>
  );
}
