import { useEffect, useState } from "react";
import type { AppSettingsResponse } from "@fastcar/shared";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);

/** True for localhost-style hosts, including *.localhost (RFC 6761). */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return LOOPBACK.has(h) || h.endsWith(".localhost");
}

/**
 * Warn when fastcar is building every public link from localhost while this
 * page was clearly loaded from somewhere else.
 *
 * The server cannot tell a deployment that forgot FASTCAR_PUBLIC_URL from a
 * developer's laptop — the localhost fallback is right for one and wrong for
 * the other. The browser can: it knows the address people actually reach
 * fastcar at. This only warns, and only on a loopback-vs-real mismatch, so
 * `npm run dev:web` (localhost:5173 against a localhost:3000 public URL) stays
 * quiet. Nothing is inferred server-side from the Host header, which a caller
 * can spoof into links pointing at their own domain.
 */
export function PublicUrlBanner() {
  const [server, setServer] = useState<AppSettingsResponse["server"] | null>(null);

  useEffect(() => {
    void fetch("/api/settings")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: AppSettingsResponse | null) => d && setServer(d.server))
      .catch(() => {});
  }, []);

  if (!server) return null;
  let configuredHost: string;
  try {
    configuredHost = new URL(server.publicUrl).hostname;
  } catch {
    return null;
  }
  if (!isLoopbackHost(configuredHost) || isLoopbackHost(location.hostname)) return null;

  return (
    <div
      role="alert"
      className="border-b border-warn/40 bg-warn/10 px-4 py-2 text-[0.78rem] text-ink-dim"
    >
      <span className="font-medium text-warn">Links fastcar hands out are broken for everyone else.</span>{" "}
      Artifact links and MCP sign-in redirects are being built from{" "}
      <code className="text-ink">{server.publicUrl}</code>, but you're using{" "}
      <code className="text-ink">{location.origin}</code>. Set{" "}
      <code className="text-ink">FASTCAR_PUBLIC_URL={location.origin}</code> in the server's environment
      {server.publicUrlFromEnv ? " (it is currently set to a localhost address)" : ""} and restart it.
      Links already shown in the artifacts panel and inbox update on their own; links an agent pasted into a
      reply do not.
    </div>
  );
}
