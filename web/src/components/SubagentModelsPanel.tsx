import { useEffect, useState } from "react";
import {
  SUBAGENT_PROVIDERS,
  type SubagentProvider,
  type SubagentSettingsResponse,
} from "@fastcar/shared";

/**
 * The delegation pools maxcoding and minimodel — the workers an agent hands
 * tasks to via run_subagent, not agents in their own right.
 *
 * GET/POST /api/subagent-models has existed since the subagent-model feature
 * landed but had no interface at all; this is it.
 */
export function SubagentModelsPanel() {
  const [data, setData] = useState<SubagentSettingsResponse | null>(null);
  const [provider, setProvider] = useState<SubagentProvider>("openrouter");
  const [omlxBaseUrl, setOmlxBaseUrl] = useState("");
  const [maxcoding, setMaxcoding] = useState("");
  const [minimodel, setMinimodel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void fetch("/api/subagent-models")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: SubagentSettingsResponse | null) => {
        if (!d) return;
        setData(d);
        setProvider(d.provider);
        setOmlxBaseUrl(d.omlxBaseUrl);
        setMaxcoding(d.maxcoding.model ?? "");
        setMinimodel(d.minimodel.model ?? "");
      })
      .catch(() => setError("could not load subagent settings"));
  }, []);

  const save = async () => {
    setBusy(true);
    setError(null);
    setSaved(false);
    const res = await fetch("/api/subagent-models", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider,
        omlxBaseUrl,
        // Blank means "fall back to the env default", which is what null encodes.
        maxcoding: { model: maxcoding.trim() || null },
        minimodel: { model: minimodel.trim() || null },
      }),
    });
    setBusy(false);
    if (!res.ok) {
      setError(
        res.status === 403
          ? "Subagent settings are admin-only."
          : (((await res.json().catch(() => ({}))) as { error?: string }).error ?? "failed to save"),
      );
      return;
    }
    setData((await res.json()) as SubagentSettingsResponse);
    setSaved(true);
  };

  const input =
    "w-full rounded-lg border border-border bg-panel-2 px-3 py-2 text-sm text-ink outline-none focus:border-accent/60";
  const lab = "block text-[0.72rem] text-ink-faint";

  return (
    <>
      <h3 className="border-b border-border pb-1 text-[0.7rem] font-semibold uppercase tracking-wide text-ink-dim">
        Delegation workers
      </h3>
      <p className="text-[0.72rem] text-ink-faint">
        <span className="text-ink-dim">maxcoding</span> and{" "}
        <span className="text-ink-dim">minimodel</span> are the workers an agent delegates to
        with <code className="text-ink-dim">run_subagent</code>. They own no threads and have no
        inbox of their own. A blank model falls back to the environment default; changes apply
        to the next task, with no restart.
      </p>

      <label className={lab}>
        Provider
        <select
          value={provider}
          onChange={(e) => setProvider(e.target.value as SubagentProvider)}
          className={input + " mt-1"}
        >
          {SUBAGENT_PROVIDERS.map((p) => (
            <option key={p} value={p}>
              {p}
              {data && p === data.defaults.provider ? " (env default)" : ""}
            </option>
          ))}
        </select>
      </label>

      {provider === "omlx" && (
        <label className={lab}>
          OMLX base URL
          <input
            value={omlxBaseUrl}
            onChange={(e) => setOmlxBaseUrl(e.target.value)}
            placeholder={data?.defaults.omlxBaseUrl}
            className={input + " mt-1 font-mono text-[0.8rem]"}
          />
        </label>
      )}

      <label className={lab}>
        maxcoding — the heavyweight coding worker
        <input
          value={maxcoding}
          onChange={(e) => setMaxcoding(e.target.value)}
          placeholder={data?.defaults.maxcodingModel}
          className={input + " mt-1 font-mono text-[0.8rem]"}
        />
      </label>

      <label className={lab}>
        minimodel — the fast, cheap read-only worker
        <input
          value={minimodel}
          onChange={(e) => setMinimodel(e.target.value)}
          placeholder={data?.defaults.minimodelModel}
          className={input + " mt-1 font-mono text-[0.8rem]"}
        />
      </label>

      {error && <p className="text-[0.72rem] text-danger">⚠ {error}</p>}
      {saved && <p className="text-[0.72rem] text-accent">✓ Saved.</p>}

      <div className="flex justify-end gap-2">
        <button
          onClick={() => {
            if (!data) return;
            setProvider(data.defaults.provider);
            setOmlxBaseUrl(data.defaults.omlxBaseUrl);
            setMaxcoding("");
            setMinimodel("");
          }}
          disabled={!data}
          className="rounded-lg border border-border px-3 py-1.5 text-sm text-ink-dim hover:bg-panel-2 disabled:opacity-40"
        >
          Reset to env
        </button>
        <button
          onClick={() => void save()}
          disabled={busy || !data}
          className="rounded-lg border border-accent-dim/50 bg-accent-dim/20 px-4 py-1.5 text-sm text-accent hover:bg-accent-dim/30 disabled:opacity-40"
        >
          {busy ? "Saving…" : "Save workers"}
        </button>
      </div>
    </>
  );
}
