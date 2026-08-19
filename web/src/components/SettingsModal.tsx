import { useEffect, useState } from "react";
import type { SmtpSettingsResponse } from "@fastcar/shared";
import { useStore } from "../state/store.ts";
import { ModalShell } from "./AddArtifactModal.tsx";

/**
 * Settings modal (Feature 2): SMTP host/port/username/password/from-address
 * and a TLS/SSL toggle. Stored encrypted server-side. Admin only — the server
 * returns 403 when FASTCAR_ADMIN_TOKEN is set and the caller is not an admin;
 * in single-user dev mode the fields are always editable.
 */
export function SettingsModal() {
  const setModal = useStore((s) => s.setModal);
  const lastSlashResult = useStore((s) => s.lastSlashResult);

  const [host, setHost] = useState("");
  const [port, setPort] = useState(587);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [fromAddress, setFromAddress] = useState("");
  const [secure, setSecure] = useState(false);
  const [configured, setConfigured] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void load();
  }, []);

  const load = async () => {
    try {
      const res = await fetch("/api/smtp");
      if (!res.ok) {
        if (res.status === 403) {
          setError("SMTP settings are admin-only.");
        }
        return;
      }
      const data = (await res.json()) as SmtpSettingsResponse;
      setHost(data.host);
      setPort(data.port);
      setUsername(data.username);
      setFromAddress(data.fromAddress);
      setSecure(data.secure);
      setConfigured(data.configured);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch("/api/smtp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          host: host.trim(),
          port: Number(port) || 587,
          username: username.trim(),
          password: password || undefined,
          fromAddress: fromAddress.trim(),
          secure,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `save failed (${res.status})`);
      }
      const data = (await res.json()) as SmtpSettingsResponse;
      setConfigured(data.configured);
      setPassword("");
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalShell title="Settings — SMTP" onClose={() => setModal("none")}>
      <p className="text-[0.72rem] text-ink-faint">
        SMTP credentials are stored encrypted at rest on the server. The password is
        never returned; leave it blank to keep the existing value.
        {configured ? " ✓ SMTP is configured." : ""}
      </p>

      <div className="grid grid-cols-2 gap-2">
        <Field label="SMTP Host" className="col-span-2">
          <input
            value={host}
            onChange={(e) => setHost(e.target.value)}
            placeholder="smtp.example.com"
            className="w-full rounded-lg border border-border bg-panel-2 px-3 py-2 text-sm text-ink outline-none focus:border-accent/60"
          />
        </Field>
        <Field label="Port">
          <input
            type="number"
            value={port}
            onChange={(e) => setPort(Number(e.target.value))}
            className="w-full rounded-lg border border-border bg-panel-2 px-3 py-2 text-sm text-ink outline-none focus:border-accent/60"
          />
        </Field>
        <Field label="Username">
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="w-full rounded-lg border border-border bg-panel-2 px-3 py-2 text-sm text-ink outline-none focus:border-accent/60"
          />
        </Field>
        <Field label="Password">
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="•••••• (leave blank to keep)"
            className="w-full rounded-lg border border-border bg-panel-2 px-3 py-2 text-sm text-ink outline-none focus:border-accent/60"
          />
        </Field>
        <Field label="From Address">
          <input
            value={fromAddress}
            onChange={(e) => setFromAddress(e.target.value)}
            placeholder="fastcar@example.com"
            className="w-full rounded-lg border border-border bg-panel-2 px-3 py-2 text-sm text-ink outline-none focus:border-accent/60"
          />
        </Field>
      </div>

      <label className="flex items-center gap-2 text-sm text-ink-dim">
        <input
          type="checkbox"
          checked={secure}
          onChange={(e) => setSecure(e.target.checked)}
          className="accent-[var(--color-accent)]"
        />
        Use TLS/SSL (implicit TLS on the port above)
      </label>

      <div className="rounded-lg border border-border bg-panel-2/60 px-3 py-2 text-[0.72rem] text-ink-faint">
        <p>
          Send a test email with the structured slash command:{" "}
          <code className="text-ink-dim">
            {`{type:"slash", command:"/email", args:{to,subject,body}}`}
          </code>
        </p>
        {lastSlashResult && (
          <p className={lastSlashResult.ok ? "mt-1 text-accent" : "mt-1 text-danger"}>
            {lastSlashResult.ok ? "✓" : "⚠"} {lastSlashResult.message}
          </p>
        )}
      </div>

      {error && <p className="text-[0.72rem] text-danger">⚠ {error}</p>}
      {saved && <p className="text-[0.72rem] text-accent">✓ Saved.</p>}

      <div className="flex justify-end gap-2">
        <button
          onClick={() => setModal("none")}
          className="rounded-lg border border-border px-3 py-1.5 text-sm text-ink-dim hover:bg-panel-2"
        >
          Close
        </button>
        <button
          onClick={() => void save()}
          disabled={busy}
          className="rounded-lg border border-accent-dim/50 bg-accent-dim/20 px-4 py-1.5 text-sm text-accent hover:bg-accent-dim/30 disabled:opacity-40"
        >
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
    </ModalShell>
  );
}

function Field({
  label,
  children,
  className = "",
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={`block text-[0.72rem] text-ink-faint ${className}`}>
      {label}
      <div className="mt-1">{children}</div>
    </label>
  );
}
