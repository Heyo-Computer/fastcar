import { useEffect, useMemo, useState } from "react";
import type { AgentModelProvider, ToolCategory } from "@fastcar/shared";
import { useStore } from "../state/store.ts";
import { navigate } from "../lib/router.ts";

const CATEGORY_LABEL: Record<ToolCategory, string> = {
  filesystem: "Files",
  shell: "Shell",
  delegation: "Delegation",
  interaction: "Talking to you",
  memory: "Memory",
  web: "Web",
  git: "Git",
  ops: "Infrastructure",
  artifacts: "Artifacts",
  mcp: "MCP",
  email: "Email",
  signal: "Signal",
};

const CATEGORY_ORDER: ToolCategory[] = [
  "interaction", "web", "artifacts", "memory", "filesystem", "shell",
  "delegation", "git", "mcp", "ops", "email", "signal",
];

const field =
  "w-full rounded-lg border border-border bg-panel px-2.5 py-1.5 text-sm text-ink outline-none focus:border-accent-dim";
const label = "block text-[0.72rem] uppercase tracking-wide text-ink-faint mb-1";

export function AgentBuilderView({ agentId }: { agentId?: string }) {
  const agents = useStore((s) => s.agents);
  const toolCatalog = useStore((s) => s.toolCatalog);
  const modelCatalog = useStore((s) => s.modelCatalog);
  const mcpServers = useStore((s) => s.mcpServers);
  const loadToolCatalog = useStore((s) => s.loadToolCatalog);
  const loadModelCatalog = useStore((s) => s.loadModelCatalog);
  const loadAgents = useStore((s) => s.loadAgents);

  const existing = agentId ? agents.find((a) => a.id === agentId) : undefined;
  const readOnly = Boolean(existing?.isBuiltin);

  const [name, setName] = useState("");
  const [avatar, setAvatar] = useState("🤖");
  const [description, setDescription] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [provider, setProvider] = useState<AgentModelProvider>("inceptionlabs");
  const [modelSlug, setModelSlug] = useState("");
  const [effort, setEffort] = useState<"" | "instant" | "medium" | "high">("");
  const [tools, setTools] = useState<string[]>([]);
  const [mcpSubset, setMcpSubset] = useState<string[] | null>(null);
  const [supportsPlanMode, setSupportsPlanMode] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void loadToolCatalog();
    void loadModelCatalog();
  }, [loadToolCatalog, loadModelCatalog]);

  // Seed the form once the agent arrives (it may load after first render).
  useEffect(() => {
    if (!existing) return;
    setName(existing.name);
    setAvatar(existing.avatar ?? "🤖");
    setDescription(existing.description);
    setSystemPrompt(existing.systemPrompt ?? "");
    setProvider(existing.resolved.modelProvider);
    setModelSlug(existing.resolved.modelSlug);
    setEffort(existing.reasoningEffort ?? "");
    setTools(existing.resolved.tools);
    setMcpSubset(existing.mcpServers);
    setSupportsPlanMode(existing.supportsPlanMode);
  }, [existing]);

  const providerInfo = modelCatalog.find((p) => p.id === provider);
  const selectedModel = providerInfo?.models.find((m) => m.slug === modelSlug);
  // Pi only emits reasoning_effort for reasoning-capable models, and unknown
  // slugs register as overlays with reasoning:false — so the control would be
  // a silent no-op there. Say so rather than pretend.
  const effortApplies = selectedModel?.reasoningCapable ?? false;

  // Default the slug when the provider changes to one with a fixed catalog.
  useEffect(() => {
    if (!providerInfo) return;
    if (!providerInfo.allowsArbitrarySlug && providerInfo.models.length) {
      setModelSlug(providerInfo.models[0]!.slug);
    }
  }, [provider, providerInfo]);

  const byCategory = useMemo(() => {
    const m = new Map<ToolCategory, typeof toolCatalog>();
    for (const t of toolCatalog) {
      const list = m.get(t.category) ?? [];
      list.push(t);
      m.set(t.category, list);
    }
    return m;
  }, [toolCatalog]);

  const toggleTool = (nameToToggle: string) => {
    setTools((prev) =>
      prev.includes(nameToToggle) ? prev.filter((t) => t !== nameToToggle) : [...prev, nameToToggle],
    );
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    const body = {
      name,
      avatar,
      description,
      systemPrompt,
      modelProvider: provider,
      modelSlug,
      reasoningEffort: effort || null,
      tools,
      mcpServers: mcpSubset,
      supportsPlanMode,
    };
    const res = await fetch(existing ? `/api/agents/${existing.id}` : "/api/agents", {
      method: existing ? "PATCH" : "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    setBusy(false);
    if (!res.ok) {
      setError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? "failed to save");
      return;
    }
    const saved = (await res.json()) as { agent: { id: string } };
    await loadAgents();
    navigate({ name: "agent", agentId: saved.agent.id, tab: "threads" });
  };

  const duplicate = () => {
    // A builtin cannot be edited (its prompt, model and tools come from code),
    // so the way to customise it is to start a new agent from its resolution.
    navigate({ name: "agentNew" });
    setTimeout(() => {
      setName(`${existing?.name ?? "Agent"} copy`);
      setSystemPrompt(existing?.resolved.tools.length ? systemPrompt : "");
    }, 0);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-center gap-3 border-b border-border bg-panel px-6 py-3">
        <h2 className="font-medium text-ink">
          {existing ? (readOnly ? `${existing.name} (built in)` : `Edit ${existing.name}`) : "New agent"}
        </h2>
        <div className="ml-auto flex gap-2">
          {readOnly ? (
            <button
              onClick={duplicate}
              className="rounded-lg border border-accent-dim/40 bg-accent-dim/20 px-3 py-1.5 text-sm text-accent hover:bg-accent-dim/30"
            >
              Duplicate to customise
            </button>
          ) : (
            <button
              disabled={busy || !name.trim() || !systemPrompt.trim() || !modelSlug}
              onClick={() => void save()}
              className="rounded-lg border border-accent-dim/40 bg-accent-dim/20 px-3 py-1.5 text-sm text-accent hover:bg-accent-dim/30 disabled:opacity-40"
            >
              {busy ? "Saving…" : existing ? "Save" : "Create agent"}
            </button>
          )}
          <button
            onClick={() => navigate(existing ? { name: "agent", agentId: existing.id, tab: "threads" } : { name: "agents" })}
            className="rounded-lg border border-border px-3 py-1.5 text-sm text-ink-dim hover:bg-panel-2"
          >
            Cancel
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <fieldset disabled={readOnly} className="mx-auto max-w-3xl space-y-6 px-6 py-5">
          {readOnly && (
            <p className="rounded-lg border border-border bg-panel-2/40 px-3 py-2 text-[0.78rem] text-ink-dim">
              The built-in conductor's role, model and tools come from code, so environment
              settings and prompt changes keep taking effect. Duplicate it to make your own.
            </p>
          )}

          <div className="grid gap-3 sm:grid-cols-[4rem_1fr]">
            <div>
              <label className={label}>Icon</label>
              <input className={field + " text-center text-lg"} value={avatar} onChange={(e) => setAvatar(e.target.value)} maxLength={4} />
            </div>
            <div>
              <label className={label}>Name</label>
              <input className={field} value={name} onChange={(e) => setName(e.target.value)} placeholder="News Desk" />
            </div>
          </div>

          <div>
            <label className={label}>Description</label>
            <input
              className={field}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Curates a daily news brief"
            />
          </div>

          <div>
            <label className={label}>Role</label>
            <textarea
              className={field + " min-h-[150px] resize-y font-mono text-[0.82rem]"}
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              placeholder="You curate a daily news brief. Search for the day's top stories, then publish a self-contained HTML artifact…"
            />
            <p className="mt-1 text-[0.72rem] text-ink-faint">
              This is the agent's system prompt. Guidance for the tools you grant below is
              appended automatically — you do not need to explain them here.
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <label className={label}>Provider</label>
              <select
                className={field}
                value={provider}
                onChange={(e) => setProvider(e.target.value as AgentModelProvider)}
              >
                {modelCatalog.map((p) => (
                  <option key={p.id} value={p.id} disabled={!p.configured}>
                    {p.label}
                    {p.configured ? "" : " (no API key)"}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={label}>Model</label>
              {providerInfo?.allowsArbitrarySlug ? (
                <input
                  className={field + " font-mono text-[0.8rem]"}
                  value={modelSlug}
                  onChange={(e) => setModelSlug(e.target.value)}
                  list="model-slugs"
                  placeholder="anthropic/claude-sonnet-4.5"
                />
              ) : (
                <select className={field} value={modelSlug} onChange={(e) => setModelSlug(e.target.value)}>
                  {providerInfo?.models.map((m) => (
                    <option key={m.slug} value={m.slug}>
                      {m.label}
                    </option>
                  ))}
                </select>
              )}
              <datalist id="model-slugs">
                {providerInfo?.models.map((m) => (
                  <option key={m.slug} value={m.slug} />
                ))}
              </datalist>
            </div>
            <div>
              <label className={label}>Reasoning effort</label>
              <select
                className={field + (effortApplies ? "" : " opacity-50")}
                value={effort}
                disabled={!effortApplies}
                onChange={(e) => setEffort(e.target.value as typeof effort)}
              >
                <option value="">Follow the global setting</option>
                <option value="instant">instant</option>
                <option value="medium">medium</option>
                <option value="high">high</option>
              </select>
              {!effortApplies && (
                <p className="mt-1 text-[0.68rem] text-ink-faint">
                  This model does not take a reasoning effort.
                </p>
              )}
            </div>
          </div>

          <div>
            <div className="mb-2 flex items-baseline gap-2">
              <span className={label + " mb-0"}>Tools</span>
              <span className="text-[0.72rem] text-ink-faint">
                {/* Always-on tools render checked, so counting only `tools`
                    would show "0 granted" beside two ticked boxes. */}
                {new Set([...tools, ...toolCatalog.filter((t) => t.alwaysOn).map((t) => t.name)]).size}{" "}
                granted
              </span>
            </div>
            <div className="space-y-3">
              {CATEGORY_ORDER.filter((c) => byCategory.has(c)).map((cat) => (
                <div key={cat}>
                  <div className="mb-1 text-[0.7rem] font-medium text-ink-dim">{CATEGORY_LABEL[cat]}</div>
                  <div className="grid gap-1 sm:grid-cols-2">
                    {byCategory.get(cat)!.map((t) => {
                      const on = tools.includes(t.name) || t.alwaysOn;
                      return (
                        <label
                          key={t.name}
                          title={t.available ? t.description : t.unavailableReason}
                          className={
                            "flex items-start gap-2 rounded-lg border px-2.5 py-1.5 text-[0.78rem] " +
                            (t.available ? "cursor-pointer " : "opacity-45 ") +
                            (on ? "border-accent-dim/40 bg-accent-dim/10" : "border-border hover:bg-panel-2/60")
                          }
                        >
                          <input
                            type="checkbox"
                            className="mt-0.5 accent-[var(--color-accent)]"
                            checked={on}
                            disabled={t.alwaysOn || !t.available}
                            onChange={() => toggleTool(t.name)}
                          />
                          <span className="min-w-0">
                            <span className="flex items-center gap-1.5">
                              <span className="text-ink">{t.label}</span>
                              {t.mutating && (
                                <span className="rounded border border-warn/40 px-1 text-[0.6rem] uppercase text-warn">
                                  writes
                                </span>
                              )}
                              {t.alwaysOn && (
                                <span className="rounded border border-border px-1 text-[0.6rem] uppercase text-ink-faint">
                                  always
                                </span>
                              )}
                            </span>
                            <span className="block truncate text-[0.7rem] text-ink-faint">
                              {t.available ? t.description : t.unavailableReason}
                            </span>
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div>
            <label className={label}>MCP servers</label>
            {mcpServers.length === 0 ? (
              <p className="text-[0.78rem] text-ink-faint">
                None installed. Add one from Settings → MCP.
              </p>
            ) : (
              <div className="space-y-1">
                <label className="flex items-center gap-2 text-[0.78rem] text-ink-dim">
                  <input
                    type="checkbox"
                    className="accent-[var(--color-accent)]"
                    checked={mcpSubset === null}
                    onChange={(e) => setMcpSubset(e.target.checked ? null : [])}
                  />
                  Every installed server (including ones added later)
                </label>
                {mcpSubset !== null &&
                  mcpServers.map((srv) => (
                    <label key={srv.name} className="ml-5 flex items-center gap-2 text-[0.78rem] text-ink-dim">
                      <input
                        type="checkbox"
                        className="accent-[var(--color-accent)]"
                        checked={mcpSubset.includes(srv.name)}
                        onChange={() =>
                          setMcpSubset((prev) =>
                            prev!.includes(srv.name)
                              ? prev!.filter((n) => n !== srv.name)
                              : [...prev!, srv.name],
                          )
                        }
                      />
                      {srv.name}
                      <span className="text-ink-faint">({srv.tools.length} tools)</span>
                    </label>
                  ))}
              </div>
            )}
          </div>

          <label className="flex items-center gap-2 text-[0.82rem] text-ink-dim">
            <input
              type="checkbox"
              className="accent-[var(--color-accent)]"
              checked={supportsPlanMode}
              onChange={(e) => setSupportsPlanMode(e.target.checked)}
            />
            Allow planning mode (explore read-only, then submit a plan for approval)
          </label>

          {error && <p className="text-[0.82rem] text-danger">{error}</p>}
          <p className="text-[0.72rem] text-ink-faint">
            Changing an agent's tools or model takes effect on its threads' next turn — a run
            already in flight keeps the toolset it started with.
          </p>
        </fieldset>
      </div>
    </div>
  );
}
