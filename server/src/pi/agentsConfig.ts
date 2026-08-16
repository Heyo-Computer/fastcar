import fs from "node:fs";
import path from "node:path";
import yaml from "yaml";

/**
 * agents.yaml lives at the repository root, but the server is started from
 * server/ (`cd server && npm run dev`), so search upwards from cwd rather than
 * assuming it is the root. FASTCAR_AGENTS_FILE overrides the search.
 */
function findAgentsFile(): string | null {
  const override = process.env.FASTCAR_AGENTS_FILE?.trim();
  if (override) return fs.existsSync(override) ? override : null;
  let dir = process.cwd();
  for (let up = 0; up < 4; up++) {
    const candidate = path.join(dir, "agents.yaml");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

let agentsMap: Record<string, { name: string; description?: string }> = {};
const agentsPath = findAgentsFile();
if (agentsPath) {
  try {
    agentsMap = yaml.parse(fs.readFileSync(agentsPath, "utf8"))?.agents ?? {};
  } catch (e) {
    console.warn(`Failed to parse ${agentsPath}, falling back to defaults:`, e);
  }
} else {
  console.warn("No agents.yaml found; falling back to defaults.");
}

/** Retrieve the agent name for a given role. Returns "maxcoding" if unknown. */
export function getAgent(role: string): string {
  return agentsMap[role]?.name ?? "maxcoding";
}

export interface AgentEntry {
  /** Role key from agents.yaml, e.g. "coding". */
  role: string;
  /** Subagent name the conductor delegates to, e.g. "maxcoding". */
  name: string;
  description: string;
}

/**
 * Every configured role, de-duplicated by agent name — the same agent backs
 * several roles (general → maxcoding), and the @-menu lists agents, not roles.
 */
export function listAgents(): AgentEntry[] {
  const byName = new Map<string, AgentEntry>();
  for (const [role, entry] of Object.entries(agentsMap)) {
    if (!entry?.name || byName.has(entry.name)) continue;
    byName.set(entry.name, { role, name: entry.name, description: entry.description ?? "" });
  }
  return [...byName.values()];
}
