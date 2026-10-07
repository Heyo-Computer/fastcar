import { useEffect, useState } from "react";
import {
  PROVIDER_KEY_IDS,
  REASONING_EFFORTS,
  type AppSettingsRequest,
  type AppSettingsResponse,
  type ProviderKeyId,
  type ReasoningEffort,
  type SmtpSettingsResponse,
} from "@fastcar/shared";
import { useStore } from "../state/store.ts";
import { ModalShell } from "./AddArtifactModal.tsx";
import { RepoPanel } from "./RepoPanel.tsx";
import { McpPanel } from "./McpPanel.tsx";
import { SubagentModelsPanel } from "./SubagentModelsPanel.tsx";

const KEY_LABELS: Record<ProviderKeyId, string> = {
  inception: "InceptionLabs (conductor)",
  openrouter: "OpenRouter (subagents, transcription)",
  omlx: "OMLX (self-hosted subagents)",
};

const EMPTY_KEY_DRAFTS: Record<ProviderKeyId, string> = { inception: "", openrouter: "", omlx: "" };

const EFFORT_HELP: Record<ReasoningEffort, string> = {
  instant: "lowest latency — simple tasks, quick replies",
  medium: "default balance of quality and latency",
  high: "harder planning, reasoning and coding tasks (slower)",
};

/**
 * Settings modal: the conductor's model, budget and reasoning effort (Mercury
 * `reasoning_effort`, applied to live threads from their next turn), provider
 * API keys (stored encrypted, only ever shown masked) and SMTP host/port/username/
 * password/from-address with a TLS/SSL toggle (stored encrypted server-side).
 * Saving is admin only — the server returns 403 when FASTCAR_ADMIN_TOKEN is
 * set and the caller is not an admin; in single-user dev mode everything is
 * editable.
 */
type SettingsTab = "general" | "workers" | "repos" | "mcp" | "email";

export function SettingsModal() {
  const setModal = useStore((s) => s.setModal);
  const [tab, setTab] = useState<SettingsTab>("general");
  const lastSlashResult = useStore((s) => s.lastSlashResult);

  const [conductor, setConductor] = useState<AppSettingsResponse["conductor"] | null>(null);
  const [keys, setKeys] = useState<AppSettingsResponse["keys"] | null>(null);
  const [effort, setEffort] = useState<ReasoningEffort>("medium");
  const [modelId, setModelId] = useState("");
  const [maxTokens, setMaxTokens] = useState("");
  const [keyDrafts, setKeyDrafts] = useState(EMPTY_KEY_DRAFTS);
  const [keysBusy, setKeysBusy] = useState(false);
  const [keysError, setKeysError] = useState<string | null>(null);
  const [keysSaved, setKeysSaved] = useState(false);
  const [effortBusy, setEffortBusy] = useState(false);
  const [effortError, setEffortError] = useState<string | null>(null);
  const [effortSaved, setEffortSaved] = useState(false);

  const [host, setHost] = useState("");
  const [port, setPort] = useState(587);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [fromAddress, setFromAddress] = useState("");
  const [secure, setSecure] = useState(false);
  const [configured, setConfigured] = useState(false);
  const [imapHost, setImapHost] = useState("");
  const [imapPort, setImapPort] = useState(993);
  const [imapSecure, setImapSecure] = useState(true);
  const [imapMailbox, setImapMailbox] = useState("INBOX");
  const [imapUsername, setImapUsername] = useState("");
  const [imapPassword, setImapPassword] = useState("");
  const [imapConfigured, setImapConfigured] = useState(false);
  const [imapStatus, setImapStatus] = useState<SmtpSettingsResponse["imapStatus"] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void loadConductor();
    void load();
  }, []);

  const loadConductor = async () => {
    try {
      const res = await fetch("/api/settings");
      if (!res.ok) throw new Error(`settings unavailable (${res.status})`);
      applySettings((await res.json()) as AppSettingsResponse);
    } catch (err) {
      setEffortError(err instanceof Error ? err.message : String(err));
    }
  };

  const applySettings = (data: AppSettingsResponse) => {
    setConductor(data.conductor);
    setKeys(data.keys);
    setEffort(data.conductor.reasoningEffort);
    setModelId(data.conductor.modelId);
    setMaxTokens(String(data.conductor.maxTokens));
  };

  /** POST a partial update; throws a user-facing message on failure. */
  const postSettings = async (body: AppSettingsRequest): Promise<void> => {
    const res = await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(res.status === 403 ? "Model settings are admin-only." : err.error ?? `save failed (${res.status})`);
    }
    applySettings((await res.json()) as AppSettingsResponse);
  };

  const conductorDirty =
    !!conductor &&
    (effort !== conductor.reasoningEffort ||
      modelId.trim() !== conductor.modelId ||
      maxTokens.trim() !== String(conductor.maxTokens));

  const saveConductor = async () => {
    setEffortBusy(true);
    setEffortError(null);
    setEffortSaved(false);
    try {
      const tokens = maxTokens.trim();
      await postSettings({
        conductor: {
          reasoningEffort: effort,
          // Blank = back to the env default.
          modelId: modelId.trim() || null,
          maxTokens: tokens ? Number(tokens) : null,
        },
      });
      setEffortSaved(true);
    } catch (err) {
      setEffortError(err instanceof Error ? err.message : String(err));
    } finally {
      setEffortBusy(false);
    }
  };

  const keysDirty = PROVIDER_KEY_IDS.some((id) => keyDrafts[id].trim());

  /** Save typed keys, or clear one override (null) to fall back to the env var. */
  const saveKeys = async (update: AppSettingsRequest["keys"]) => {
    setKeysBusy(true);
    setKeysError(null);
    setKeysSaved(false);
    try {
      await postSettings({ keys: update });
      setKeyDrafts(EMPTY_KEY_DRAFTS);
      setKeysSaved(true);
    } catch (err) {
      setKeysError(err instanceof Error ? err.message : String(err));
    } finally {
      setKeysBusy(false);
    }
  };

  const applyImap = (data: SmtpSettingsResponse) => {
    setImapHost(data.imapHost);
    setImapPort(data.imapPort);
    setImapSecure(data.imapSecure);
    setImapMailbox(data.imapMailbox);
    setImapUsername(data.imapUsername);
    setImapConfigured(data.imapConfigured);
    setImapStatus(data.imapStatus);
  };

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
      applyImap(data);
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
          imapHost: imapHost.trim(),
          imapPort: Number(imapPort) || 993,
          imapSecure,
          imapMailbox: imapMailbox.trim() || "INBOX",
          imapUsername: imapUsername.trim(),
          imapPassword: imapPassword || undefined,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `save failed (${res.status})`);
      }
      const data = (await res.json()) as SmtpSettingsResponse;
      setConfigured(data.configured);
      applyImap(data);
      setPassword("");
      setImapPassword("");
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const general = (
    <>
      <SectionTitle>Conductor model</SectionTitle>
      <p className="text-[0.72rem] text-ink-faint">
        {conductor ? (
          <>
            Running on <code className="text-ink-dim">{conductor.model}</code> with a{" "}
            {conductor.maxTokens.toLocaleString()}-token budget shared by reasoning and the answer.
            Changes apply to every thread from its next turn.
          </>
        ) : (
          "Loading…"
        )}
      </p>

      <div className="grid grid-cols-3 gap-2">
        <Field label="Model id" className="col-span-2">
          <input
            value={modelId}
            onChange={(e) => setModelId(e.target.value)}
            disabled={!conductor}
            placeholder={conductor?.defaultModelId}
            className="w-full rounded-lg border border-border bg-panel-2 px-3 py-2 text-sm text-ink outline-none focus:border-accent/60"
          />
        </Field>
        <Field label="Max tokens">
          <input
            type="number"
            min={1}
            value={maxTokens}
            onChange={(e) => setMaxTokens(e.target.value)}
            disabled={!conductor}
            placeholder={conductor ? String(conductor.defaultMaxTokens) : undefined}
            className="w-full rounded-lg border border-border bg-panel-2 px-3 py-2 text-sm text-ink outline-none focus:border-accent/60"
          />
        </Field>
      </div>
      {conductor && (
        <p className="text-[0.72rem] text-ink-faint">
          Env default: <code className="text-ink-dim">{conductor.defaultModelId}</code>,{" "}
          {conductor.defaultMaxTokens.toLocaleString()} tokens. Clear a field to go back to it.
        </p>
      )}

      <Field label="Reasoning effort">
        <select
          value={effort}
          onChange={(e) => setEffort(e.target.value as ReasoningEffort)}
          disabled={!conductor}
          className="w-full rounded-lg border border-border bg-panel-2 px-3 py-2 text-sm text-ink outline-none focus:border-accent/60"
        >
          {REASONING_EFFORTS.map((value) => (
            <option key={value} value={value}>
              {value} — {EFFORT_HELP[value]}
              {conductor && value === conductor.defaultReasoningEffort ? " (env default)" : ""}
            </option>
          ))}
        </select>
      </Field>

      {effortError && <p className="text-[0.72rem] text-danger">⚠ {effortError}</p>}
      {effortSaved && <p className="text-[0.72rem] text-accent">✓ Saved.</p>}

      <div className="flex justify-end">
        <button
          onClick={() => void saveConductor()}
          disabled={effortBusy || !conductorDirty}
          className="rounded-lg border border-accent-dim/50 bg-accent-dim/20 px-4 py-1.5 text-sm text-accent hover:bg-accent-dim/30 disabled:opacity-40"
        >
          {effortBusy ? "Saving…" : "Save conductor"}
        </button>
      </div>

      <SectionTitle>API keys</SectionTitle>
      <p className="text-[0.72rem] text-ink-faint">
        A key saved here overrides the environment variable and is stored encrypted on the server.
        Keys are never shown in full, wherever they came from. New keys apply from the next request.
      </p>

      {keys &&
        PROVIDER_KEY_IDS.map((id) => {
          const st = keys[id];
          return (
            <Field key={id} label={KEY_LABELS[id]}>
              <div className="flex items-center gap-2">
                <input
                  type="password"
                  autoComplete="off"
                  value={keyDrafts[id]}
                  onChange={(e) => setKeyDrafts((d) => ({ ...d, [id]: e.target.value }))}
                  placeholder={st.preview ? `${st.preview} (leave blank to keep)` : "not set"}
                  className="min-w-0 flex-1 rounded-lg border border-border bg-panel-2 px-3 py-2 text-sm text-ink outline-none focus:border-accent/60"
                />
                {st.source === "settings" && (
                  <button
                    onClick={() => void saveKeys({ [id]: null })}
                    disabled={keysBusy}
                    title={`Remove the override and use ${st.envVar} from the environment`}
                    className="rounded-lg border border-border px-2.5 py-1.5 text-[0.72rem] text-ink-dim hover:bg-panel-2 disabled:opacity-40"
                  >
                    Clear
                  </button>
                )}
              </div>
              <span className="mt-0.5 block text-[0.68rem]">
                {st.source === "settings"
                  ? `set in settings (overrides ${st.envVar})`
                  : st.source === "env"
                    ? `from ${st.envVar}`
                    : `not set — ${st.envVar} is empty`}
              </span>
            </Field>
          );
        })}

      {keysError && <p className="text-[0.72rem] text-danger">⚠ {keysError}</p>}
      {keysSaved && <p className="text-[0.72rem] text-accent">✓ Saved.</p>}

      <div className="flex justify-end">
        <button
          onClick={() =>
            void saveKeys(
              Object.fromEntries(
                PROVIDER_KEY_IDS.filter((id) => keyDrafts[id].trim()).map((id) => [id, keyDrafts[id].trim()]),
              ),
            )
          }
          disabled={keysBusy || !keysDirty}
          className="rounded-lg border border-accent-dim/50 bg-accent-dim/20 px-4 py-1.5 text-sm text-accent hover:bg-accent-dim/30 disabled:opacity-40"
        >
          {keysBusy ? "Saving…" : "Save keys"}
        </button>
      </div>

    </>
  );

  const emailTab = (
    <>
      <SectionTitle>SMTP</SectionTitle>
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
        Require TLS (implicit on 465, STARTTLS on other ports)
      </label>

      <SectionTitle>Incoming mail (IMAP)</SectionTitle>
      <p className="text-[0.72rem] text-ink-faint">
        Lets agents read the mailbox and wait for replies (email_list / email_read). Leave the host
        blank to keep email send-only. Username and password default to the SMTP login; Gmail,
        iCloud and Outlook need an app password.
        {imapConfigured && imapStatus ? ` ${imapStatusText(imapStatus)}` : ""}
      </p>

      <div className="grid grid-cols-2 gap-2">
        <Field label="IMAP Host" className="col-span-2">
          <input
            value={imapHost}
            onChange={(e) => setImapHost(e.target.value)}
            placeholder="imap.example.com"
            className="w-full rounded-lg border border-border bg-panel-2 px-3 py-2 text-sm text-ink outline-none focus:border-accent/60"
          />
        </Field>
        <Field label="Port">
          <input
            type="number"
            value={imapPort}
            onChange={(e) => setImapPort(Number(e.target.value))}
            className="w-full rounded-lg border border-border bg-panel-2 px-3 py-2 text-sm text-ink outline-none focus:border-accent/60"
          />
        </Field>
        <Field label="Mailbox">
          <input
            value={imapMailbox}
            onChange={(e) => setImapMailbox(e.target.value)}
            placeholder="INBOX"
            className="w-full rounded-lg border border-border bg-panel-2 px-3 py-2 text-sm text-ink outline-none focus:border-accent/60"
          />
        </Field>
        <Field label="Username (optional)">
          <input
            value={imapUsername}
            onChange={(e) => setImapUsername(e.target.value)}
            placeholder="same as SMTP"
            className="w-full rounded-lg border border-border bg-panel-2 px-3 py-2 text-sm text-ink outline-none focus:border-accent/60"
          />
        </Field>
        <Field label="Password (optional)">
          <input
            type="password"
            value={imapPassword}
            onChange={(e) => setImapPassword(e.target.value)}
            placeholder="same as SMTP / keep"
            className="w-full rounded-lg border border-border bg-panel-2 px-3 py-2 text-sm text-ink outline-none focus:border-accent/60"
          />
        </Field>
      </div>

      <label className="flex items-center gap-2 text-sm text-ink-dim">
        <input
          type="checkbox"
          checked={imapSecure}
          onChange={(e) => setImapSecure(e.target.checked)}
          className="accent-[var(--color-accent)]"
        />
        Use TLS (port 993)
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
          {busy ? "Saving…" : "Save email settings"}
        </button>
      </div>
    </>
  );

  const TABS = [
    { id: "general", label: "General", body: general },
    { id: "workers", label: "Workers", body: <SubagentModelsPanel /> },
    { id: "repos", label: "Repos", body: <RepoPanel /> },
    { id: "mcp", label: "MCP", body: <McpPanel /> },
    { id: "email", label: "Email", body: emailTab },
  ] as const;

  return (
    <ModalShell title="Settings" onClose={() => setModal("none")}>
      <div className="-mt-1 flex gap-1 border-b border-border pb-2">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={
              "rounded-lg px-2.5 py-1 text-[0.75rem] " +
              (tab === t.id
                ? "bg-panel-2 text-ink"
                : "text-ink-faint hover:bg-panel-2/60 hover:text-ink-dim")
            }
          >
            {t.label}
          </button>
        ))}
      </div>
      {TABS.find((t) => t.id === tab)?.body}
    </ModalShell>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="border-b border-border pb-1 text-[0.7rem] font-semibold uppercase tracking-wide text-ink-dim">
      {children}
    </h3>
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

function imapStatusText(st: SmtpSettingsResponse["imapStatus"]): string {
  if (st.state === "down") return `⚠ Inbox sync failing: ${st.error ?? "unknown error"}`;
  if (st.state === "running") {
    return st.lastSyncAt ? `✓ Inbox syncing (last ${new Date(st.lastSyncAt).toLocaleTimeString()}).` : "✓ Inbox connected.";
  }
  return "Inbox sync is not running.";
}
