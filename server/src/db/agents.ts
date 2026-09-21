/**
 * Agents table access. Mirrors db/threads.ts: hand-written row→record mapping
 * and the same dynamic `col()` patch builder, since the project uses raw SQL
 * over `pg` with no ORM.
 */
import type { AgentModelProvider, ReasoningEffort } from "@fastcar/shared";
import { getPool } from "./pool.js";

interface AgentRow {
  id: string;
  slug: string;
  name: string;
  description: string;
  avatar: string | null;
  system_prompt: string | null;
  model_provider: AgentModelProvider | null;
  model_slug: string | null;
  reasoning_effort: ReasoningEffort | null;
  max_tokens: number | null;
  tools: string[] | null;
  mcp_servers: string[] | null;
  supports_plan_mode: boolean;
  is_builtin: boolean;
  archived: boolean;
  owner_id: string | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * A row as stored. Null model/prompt/tools fields on a builtin mean "resolve
 * from code" — see services/agents.ts, which turns this into a ResolvedAgent.
 */
export interface AgentRecord {
  id: string;
  slug: string;
  name: string;
  description: string;
  avatar: string | null;
  systemPrompt: string | null;
  modelProvider: AgentModelProvider | null;
  modelSlug: string | null;
  reasoningEffort: ReasoningEffort | null;
  maxTokens: number | null;
  tools: string[] | null;
  mcpServers: string[] | null;
  supportsPlanMode: boolean;
  isBuiltin: boolean;
  archived: boolean;
  ownerId: string | null;
  createdAt: string;
  updatedAt: string;
}

function toRecord(row: AgentRow): AgentRecord {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    avatar: row.avatar,
    systemPrompt: row.system_prompt,
    modelProvider: row.model_provider,
    modelSlug: row.model_slug,
    reasoningEffort: row.reasoning_effort,
    maxTokens: row.max_tokens,
    tools: row.tools,
    mcpServers: row.mcp_servers,
    supportsPlanMode: row.supports_plan_mode,
    isBuiltin: row.is_builtin,
    archived: row.archived,
    ownerId: row.owner_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function listAgents(includeArchived = false): Promise<AgentRecord[]> {
  const { rows } = await getPool().query<AgentRow>(
    `SELECT * FROM agents ${includeArchived ? "" : "WHERE NOT archived"}
     ORDER BY is_builtin DESC, name ASC`,
  );
  return rows.map(toRecord);
}

export async function getAgent(id: string): Promise<AgentRecord | null> {
  const { rows } = await getPool().query<AgentRow>("SELECT * FROM agents WHERE id = $1", [id]);
  return rows[0] ? toRecord(rows[0]) : null;
}

export async function getAgentBySlug(slug: string): Promise<AgentRecord | null> {
  const { rows } = await getPool().query<AgentRow>("SELECT * FROM agents WHERE slug = $1", [slug]);
  return rows[0] ? toRecord(rows[0]) : null;
}

/** The seeded conductor. Every thread with no agent_id resolves to this. */
export async function getBuiltinAgent(): Promise<AgentRecord> {
  const rec = await getAgentBySlug("conductor");
  if (!rec) throw new Error("the builtin conductor agent is missing — run migrations");
  return rec;
}

export interface NewAgent {
  slug: string;
  name: string;
  description?: string;
  avatar?: string | null;
  systemPrompt: string;
  modelProvider: AgentModelProvider;
  modelSlug: string;
  reasoningEffort?: ReasoningEffort | null;
  maxTokens?: number | null;
  tools: string[];
  mcpServers?: string[] | null;
  supportsPlanMode?: boolean;
  ownerId?: string | null;
}

export async function createAgent(a: NewAgent): Promise<AgentRecord> {
  const { rows } = await getPool().query<AgentRow>(
    `INSERT INTO agents
       (slug, name, description, avatar, system_prompt, model_provider, model_slug,
        reasoning_effort, max_tokens, tools, mcp_servers, supports_plan_mode, owner_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     RETURNING *`,
    [
      a.slug, a.name, a.description ?? "", a.avatar ?? null, a.systemPrompt,
      a.modelProvider, a.modelSlug, a.reasoningEffort ?? null, a.maxTokens ?? null,
      JSON.stringify(a.tools),
      a.mcpServers === undefined || a.mcpServers === null ? null : JSON.stringify(a.mcpServers),
      a.supportsPlanMode ?? true, a.ownerId ?? null,
    ],
  );
  return toRecord(rows[0]!);
}

export type AgentPatch = Partial<{
  name: string;
  description: string;
  avatar: string | null;
  systemPrompt: string | null;
  modelProvider: AgentModelProvider | null;
  modelSlug: string | null;
  reasoningEffort: ReasoningEffort | null;
  maxTokens: number | null;
  tools: string[] | null;
  mcpServers: string[] | null;
  supportsPlanMode: boolean;
  archived: boolean;
}>;

export async function updateAgent(id: string, patch: AgentPatch): Promise<AgentRecord | null> {
  const sets: string[] = ["updated_at = now()"];
  const values: unknown[] = [];
  const col = (name: string, value: unknown) => {
    values.push(value);
    sets.push(`${name} = $${values.length}`);
  };
  if (patch.name !== undefined) col("name", patch.name);
  if (patch.description !== undefined) col("description", patch.description);
  if (patch.avatar !== undefined) col("avatar", patch.avatar);
  if (patch.systemPrompt !== undefined) col("system_prompt", patch.systemPrompt);
  if (patch.modelProvider !== undefined) col("model_provider", patch.modelProvider);
  if (patch.modelSlug !== undefined) col("model_slug", patch.modelSlug);
  if (patch.reasoningEffort !== undefined) col("reasoning_effort", patch.reasoningEffort);
  if (patch.maxTokens !== undefined) col("max_tokens", patch.maxTokens);
  if (patch.tools !== undefined) col("tools", patch.tools === null ? null : JSON.stringify(patch.tools));
  if (patch.mcpServers !== undefined)
    col("mcp_servers", patch.mcpServers === null ? null : JSON.stringify(patch.mcpServers));
  if (patch.supportsPlanMode !== undefined) col("supports_plan_mode", patch.supportsPlanMode);
  if (patch.archived !== undefined) col("archived", patch.archived);
  values.push(id);
  const { rows } = await getPool().query<AgentRow>(
    `UPDATE agents SET ${sets.join(", ")} WHERE id = $${values.length} RETURNING *`,
    values,
  );
  return rows[0] ? toRecord(rows[0]) : null;
}

/** How many threads an agent still owns — deletion is refused while > 0. */
export async function countThreadsForAgent(id: string): Promise<number> {
  const { rows } = await getPool().query<{ n: string }>(
    "SELECT count(*)::text AS n FROM threads WHERE agent_id = $1",
    [id],
  );
  return Number(rows[0]?.n ?? 0);
}

export async function deleteAgent(id: string): Promise<boolean> {
  const { rowCount } = await getPool().query("DELETE FROM agents WHERE id = $1", [id]);
  return (rowCount ?? 0) > 0;
}
