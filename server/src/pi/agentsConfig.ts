import fs from "node:fs";
import path from "node:path";
import yaml from "yaml";

// Load agents configuration at startup. The file is expected at the repository root.
const agentsPath = path.resolve(process.cwd(), "agents.yaml");
let agentsMap: Record<string, { name: string; description?: string }> = {};
try {
  const raw = fs.readFileSync(agentsPath, "utf8");
  const parsed = yaml.parse(raw);
  agentsMap = parsed?.agents ?? {};
} catch (e) {
  // If the file is missing or malformed, fall back to defaults.
  console.warn("Failed to load agents.yaml, falling back to defaults:", e);
}

/** Retrieve the agent name for a given role. Returns "maxcoding" if unknown. */
export function getAgent(role: string): string {
  return agentsMap[role]?.name ?? "maxcoding";
}
