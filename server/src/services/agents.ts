/**
 * Agent definitions: resolution, validation, and the change bus.
 *
 * A row's null prompt/model/tools fields mean "resolve from code" — only a
 * builtin may carry them (enforced by the agents_user_complete CHECK). Every
 * consumer wants the resolved form, so nothing outside this module should be
 * applying those fallbacks itself.
 */
import { EventEmitter } from "node:events";
import {
  AGENT_MODEL_PROVIDERS,
  REASONING_EFFORTS,
  type AgentDef,
  type AgentDraft,
  type AgentModelProvider,
  type ReasoningEffort,
} from "@fastcar/shared";
import type { Config } from "../config.js";
import * as agentsDb from "../db/agents.js";
import type { AgentRecord } from "../db/agents.js";
import { CONDUCTOR_DEFAULT_TOOLS, getTool } from "../tools/registry.js";
import type { AppSettings } from "./appSettings.js";
import type { McpManager } from "./mcp.js";

/** Emits "changed" with the agent id after every create/update/archive. */
export const agentEvents = new EventEmitter();

/** An agent with every code default applied — what the session factory uses. */
export interface ResolvedAgent {
  id: string;
  slug: string;
  name: string;
  isBuiltin: boolean;
  supportsPlanMode: boolean;
  /** Null means "use CONDUCTOR_BASE from prompts.ts" (builtin only). */
  systemPrompt: string | null;
  modelProvider: AgentModelProvider;
  modelSlug: string;
  reasoningEffort: ReasoningEffort;
  /**
   * True when the agent set reasoning_effort explicitly. The ⚙ setting must
   * not be pushed into such a session, or a global change silently overrides
   * a per-agent choice.
   */
  effortPinned: boolean;
  maxTokens: number | null;
  tools: string[];
  /** Null means every installed MCP server. */
  mcpServers: string[] | null;
}

export class AgentValidationError extends Error {}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;
/** Slugs owned by the delegation pools in agents.yaml — see the naming note. */
const RESERVED_SLUGS = new Set(["maxcoding", "minimodel"]);

export class AgentService {
  private cache = new Map<string, AgentRecord>();
  private builtinId: string | null = null;

  constructor(
    private readonly cfg: Config,
    private readonly settings?: AppSettings,
    private readonly mcp?: McpManager,
  ) {}

  private globalEffort(): ReasoningEffort {
    return this.settings?.conductorReasoningEffort() ?? this.cfg.conductorReasoningEffort;
  }

  /** Apply the code defaults a null column stands for. */
  resolve(rec: AgentRecord): ResolvedAgent {
    return {
      id: rec.id,
      slug: rec.slug,
      name: rec.name,
      isBuiltin: rec.isBuiltin,
      supportsPlanMode: rec.supportsPlanMode,
      systemPrompt: rec.systemPrompt,
      modelProvider: rec.modelProvider ?? "inceptionlabs",
      modelSlug: rec.modelSlug ?? this.cfg.inceptionModel,
      reasoningEffort: rec.reasoningEffort ?? this.globalEffort(),
      effortPinned: rec.reasoningEffort !== null,
      maxTokens: rec.maxTokens,
      tools: rec.tools ?? [...CONDUCTOR_DEFAULT_TOOLS],
      mcpServers: rec.mcpServers,
    };
  }

  /** Shape for the wire, carrying both the stored row and its resolution. */
  toDef(rec: AgentRecord): AgentDef {
    const r = this.resolve(rec);
    return {
      id: rec.id,
      slug: rec.slug,
      name: rec.name,
      description: rec.description,
      avatar: rec.avatar,
      systemPrompt: rec.systemPrompt,
      modelProvider: rec.modelProvider,
      modelSlug: rec.modelSlug,
      reasoningEffort: rec.reasoningEffort,
      maxTokens: rec.maxTokens,
      tools: rec.tools,
      mcpServers: rec.mcpServers,
      supportsPlanMode: rec.supportsPlanMode,
      isBuiltin: rec.isBuiltin,
      archived: rec.archived,
      createdAt: rec.createdAt,
      updatedAt: rec.updatedAt,
      resolved: {
        modelProvider: r.modelProvider,
        modelSlug: r.modelSlug,
        reasoningEffort: r.reasoningEffort,
        tools: r.tools,
        mcpServers: r.mcpServers,
      },
    };
  }

  async list(includeArchived = false): Promise<AgentRecord[]> {
    const rows = await agentsDb.listAgents(includeArchived);
    for (const r of rows) this.cache.set(r.id, r);
    return rows;
  }

  async get(id: string): Promise<AgentRecord | null> {
    const cached = this.cache.get(id);
    if (cached) return cached;
    const rec = await agentsDb.getAgent(id);
    if (rec) this.cache.set(rec.id, rec);
    return rec;
  }

  async builtin(): Promise<AgentRecord> {
    if (this.builtinId) {
      const cached = this.cache.get(this.builtinId);
      if (cached) return cached;
    }
    const rec = await agentsDb.getBuiltinAgent();
    this.builtinId = rec.id;
    this.cache.set(rec.id, rec);
    return rec;
  }

  /**
   * The agent that owns a thread. `agentId` is nullable — threads created
   * before agents existed, and `createThread(mode)` with no agent, both fall
   * through to the builtin conductor.
   */
  async forThread(agentId: string | null): Promise<ResolvedAgent> {
    const rec = (agentId ? await this.get(agentId) : null) ?? (await this.builtin());
    return this.resolve(rec);
  }

  // ------------------------------------------------------------- validation

  private async validate(draft: Partial<AgentDraft>, existing?: AgentRecord): Promise<void> {
    if (draft.slug !== undefined) {
      if (!SLUG_RE.test(draft.slug)) {
        throw new AgentValidationError(
          `slug must be 2-32 chars of a-z, 0-9 and '-', starting alphanumeric (got "${draft.slug}")`,
        );
      }
      if (RESERVED_SLUGS.has(draft.slug)) {
        throw new AgentValidationError(
          `"${draft.slug}" is a delegation subagent (agents.yaml), not an agent slug`,
        );
      }
      const clash = await agentsDb.getAgentBySlug(draft.slug);
      if (clash && clash.id !== existing?.id) {
        throw new AgentValidationError(`an agent with slug "${draft.slug}" already exists`);
      }
    }
    if (draft.name !== undefined && !draft.name.trim()) {
      throw new AgentValidationError("name cannot be empty");
    }
    if (draft.modelProvider !== undefined && !AGENT_MODEL_PROVIDERS.includes(draft.modelProvider)) {
      throw new AgentValidationError(
        `modelProvider must be one of ${AGENT_MODEL_PROVIDERS.join(", ")}`,
      );
    }
    if (draft.modelSlug !== undefined && !draft.modelSlug.trim()) {
      throw new AgentValidationError("modelSlug cannot be empty");
    }
    if (
      draft.reasoningEffort !== undefined &&
      draft.reasoningEffort !== null &&
      !REASONING_EFFORTS.includes(draft.reasoningEffort)
    ) {
      throw new AgentValidationError(
        `reasoningEffort must be one of ${REASONING_EFFORTS.join(", ")} or null`,
      );
    }
    if (draft.tools !== undefined) {
      const unknown = draft.tools.filter((t) => !getTool(t));
      if (unknown.length) {
        throw new AgentValidationError(`unknown tool(s): ${unknown.join(", ")}`);
      }
    }
    if (draft.mcpServers !== undefined && draft.mcpServers !== null && this.mcp) {
      const installed = new Set((await this.mcp.statuses()).map((s) => s.name));
      const missing = draft.mcpServers.filter((n) => !installed.has(n));
      if (missing.length) {
        throw new AgentValidationError(`MCP server(s) not installed: ${missing.join(", ")}`);
      }
    }
  }

  /**
   * Tools every agent gets whether or not the form checked them: ask_user so it
   * can pause for the user rather than guessing, and submit_plan when the agent
   * supports plan mode, since a plan-mode thread without it dead-ends.
   */
  private withForcedTools(tools: string[], supportsPlanMode: boolean): string[] {
    const out = [...tools];
    const add = (n: string) => {
      if (!out.includes(n)) out.push(n);
    };
    for (const def of [getTool("ask_user"), getTool("submit_plan")]) {
      if (!def?.alwaysOnForAgents) continue;
      if (def.name === "submit_plan" && !supportsPlanMode) continue;
      add(def.name);
    }
    return out;
  }

  private slugify(name: string): string {
    const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
    return SLUG_RE.test(base) ? base : `agent-${Date.now().toString(36)}`;
  }

  // ------------------------------------------------------------------ writes

  async create(draft: AgentDraft, ownerId: string | null = null): Promise<AgentRecord> {
    const slug = draft.slug?.trim() || this.slugify(draft.name);
    await this.validate({ ...draft, slug });
    const supportsPlanMode = draft.supportsPlanMode ?? true;
    const rec = await agentsDb.createAgent({
      slug,
      name: draft.name.trim(),
      description: draft.description ?? "",
      avatar: draft.avatar ?? null,
      systemPrompt: draft.systemPrompt,
      modelProvider: draft.modelProvider,
      modelSlug: draft.modelSlug.trim(),
      reasoningEffort: draft.reasoningEffort ?? null,
      maxTokens: draft.maxTokens ?? null,
      tools: this.withForcedTools(draft.tools, supportsPlanMode),
      mcpServers: draft.mcpServers ?? null,
      supportsPlanMode,
      ownerId,
    });
    this.cache.set(rec.id, rec);
    agentEvents.emit("changed", rec.id);
    return rec;
  }

  async update(id: string, patch: Partial<AgentDraft>): Promise<AgentRecord> {
    const existing = await this.get(id);
    if (!existing) throw new AgentValidationError(`no such agent: ${id}`);
    if (existing.isBuiltin) {
      // The builtin's prompt, model and tools come from code so that env vars
      // and prompt edits keep taking effect; letting the UI write them would
      // freeze it at whatever the form last submitted.
      const locked = (["systemPrompt", "modelProvider", "modelSlug", "tools"] as const).filter(
        (k) => patch[k] !== undefined,
      );
      if (locked.length) {
        throw new AgentValidationError(
          `the builtin agent's ${locked.join(", ")} come from code and cannot be edited — duplicate it instead`,
        );
      }
    }
    await this.validate(patch, existing);
    const supportsPlanMode = patch.supportsPlanMode ?? existing.supportsPlanMode;
    const rec = await agentsDb.updateAgent(id, {
      ...patch,
      ...(patch.tools !== undefined
        ? { tools: this.withForcedTools(patch.tools, supportsPlanMode) }
        : {}),
    });
    if (!rec) throw new AgentValidationError(`no such agent: ${id}`);
    this.cache.set(rec.id, rec);
    agentEvents.emit("changed", rec.id);
    return rec;
  }

  /**
   * Refused while the agent still owns threads: deleting would orphan their
   * history. The caller surfaces this as a 409 offering `archive` instead,
   * mirroring how services/git.ts refuses a purge with unsaved work.
   */
  async delete(id: string): Promise<void> {
    const rec = await this.get(id);
    if (!rec) throw new AgentValidationError(`no such agent: ${id}`);
    if (rec.isBuiltin) throw new AgentValidationError("the builtin agent cannot be deleted");
    const threads = await agentsDb.countThreadsForAgent(id);
    if (threads > 0) {
      throw new AgentValidationError(
        `"${rec.name}" still owns ${threads} thread(s). Archive it instead, or delete its threads first.`,
      );
    }
    await agentsDb.deleteAgent(id);
    this.cache.delete(id);
    agentEvents.emit("changed", id);
  }

  async archive(id: string, archived = true): Promise<AgentRecord> {
    const rec = await agentsDb.updateAgent(id, { archived });
    if (!rec) throw new AgentValidationError(`no such agent: ${id}`);
    this.cache.set(rec.id, rec);
    agentEvents.emit("changed", rec.id);
    return rec;
  }

  /** Drop cached rows so the next read reloads (used after MCP changes). */
  invalidate(): void {
    this.cache.clear();
  }
}
