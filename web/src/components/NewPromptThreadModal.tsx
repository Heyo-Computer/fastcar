import { useEffect, useMemo, useState } from "react";
import type { PromptTemplate } from "@fastcar/shared";
import { useStore } from "../state/store.ts";
import { send } from "../lib/ws.ts";
import { ModalShell } from "./AddArtifactModal.tsx";

/**
 * New Prompt Thread modal (Feature 3): pick a template, fill variables, enter
 * an HTTPS webhook URL + bearer token, and create the thread. On creation the
 * server resolves the template, runs the LLM, and POSTs the result to the
 * webhook with the bearer token.
 */
export function NewPromptThreadModal() {
  const setModal = useStore((s) => s.setModal);
  const templates = useStore((s) => s.promptTemplates);
  const loadPromptTemplates = useStore((s) => s.loadPromptTemplates);

  const [templateId, setTemplateId] = useState("");
  const [vars, setVars] = useState<Record<string, string>>({});
  const [webhookUrl, setWebhookUrl] = useState("https://");
  const [webhookToken, setWebhookToken] = useState("");
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void loadPromptTemplates();
  }, [loadPromptTemplates]);

  const template: PromptTemplate | undefined = useMemo(
    () => templates.find((t) => t.id === templateId),
    [templates, templateId],
  );

  useEffect(() => {
    if (templates.length && !templateId) setTemplateId(templates[0]!.id);
  }, [templates, templateId]);

  useEffect(() => {
    // Reset variable fields when the template changes.
    setVars({});
  }, [templateId]);

  const submit = async () => {
    setError(null);
    if (!template) {
      setError("Pick a template.");
      return;
    }
    try {
      const url = new URL(webhookUrl);
      if (url.protocol !== "https:") {
        setError("Webhook URL must use HTTPS.");
        return;
      }
    } catch {
      setError("Webhook URL is invalid.");
      return;
    }
    setBusy(true);
    useStore.setState({ awaitingCreatedThread: true });
    send({
      type: "create_prompt_thread",
      title: title.trim() || undefined,
      templateId,
      variables: vars,
      webhookUrl: webhookUrl.trim(),
      webhookToken,
    });
    setBusy(false);
    setModal("none");
  };

  return (
    <ModalShell title="New prompt thread" onClose={() => setModal("none")}>
      <p className="text-[0.72rem] text-ink-faint">
        A prompt thread resolves a template, runs the LLM once, and POSTs the
        result to a webhook with <code className="text-ink-dim">Authorization: Bearer &lt;token&gt;</code>.
      </p>

      <Field label="Title (optional)">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={`Prompt: ${templateId || "template"}`}
          className="w-full rounded-lg border border-border bg-panel-2 px-3 py-2 text-sm text-ink outline-none focus:border-accent/60"
        />
      </Field>

      <Field label="Template">
        <select
          value={templateId}
          onChange={(e) => setTemplateId(e.target.value)}
          className="w-full rounded-lg border border-border bg-panel-2 px-3 py-2 text-sm text-ink outline-none focus:border-accent/60"
        >
          {!templates.length && <option value="">(loading…)</option>}
          {templates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.id} — {t.description}
            </option>
          ))}
        </select>
        {template && (
          <p className="mt-1 whitespace-pre-wrap rounded-lg border border-border bg-panel-2/60 px-2.5 py-1.5 font-mono text-[0.7rem] text-ink-faint">
            {template.promptText}
          </p>
        )}
      </Field>

      {template?.variables?.length ? (
        <div className="grid grid-cols-1 gap-2">
          {template.variables.map((v) => (
            <Field key={v} label={`{{${v}}}`}>
              <input
                value={vars[v] ?? ""}
                onChange={(e) => setVars({ ...vars, [v]: e.target.value })}
                placeholder={v}
                className="w-full rounded-lg border border-border bg-panel-2 px-3 py-2 text-sm text-ink outline-none focus:border-accent/60"
              />
            </Field>
          ))}
        </div>
      ) : null}

      <Field label="Webhook URL (HTTPS)">
        <input
          value={webhookUrl}
          onChange={(e) => setWebhookUrl(e.target.value)}
          placeholder="https://example.com/hook"
          className="w-full rounded-lg border border-border bg-panel-2 px-3 py-2 text-sm text-ink outline-none focus:border-accent/60"
        />
      </Field>

      <Field label="Bearer token">
        <input
          type="password"
          value={webhookToken}
          onChange={(e) => setWebhookToken(e.target.value)}
          placeholder="token sent as Authorization: Bearer <token>"
          className="w-full rounded-lg border border-border bg-panel-2 px-3 py-2 text-sm text-ink outline-none focus:border-accent/60"
        />
      </Field>

      {error && <p className="text-[0.72rem] text-danger">⚠ {error}</p>}

      <div className="flex justify-end gap-2">
        <button
          onClick={() => setModal("none")}
          className="rounded-lg border border-border px-3 py-1.5 text-sm text-ink-dim hover:bg-panel-2"
        >
          Cancel
        </button>
        <button
          onClick={() => void submit()}
          disabled={busy}
          className="rounded-lg border border-accent-dim/50 bg-accent-dim/20 px-4 py-1.5 text-sm text-accent hover:bg-accent-dim/30 disabled:opacity-40"
        >
          {busy ? "Creating…" : "Create & run"}
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
