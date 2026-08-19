import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PromptTemplate } from "@fastcar/shared";

/**
 * Load predefined prompt templates (Feature 3) from `promptTemplates.json`.
 * The file is searched for upwards from cwd (like agents.yaml) and can be
 * overridden with `FASTCAR_PROMPT_TEMPLATES_FILE`.
 */
function findTemplatesFile(): string | null {
  const override = process.env.FASTCAR_PROMPT_TEMPLATES_FILE?.trim();
  if (override) return fs.existsSync(override) ? override : null;
  let dir = process.cwd();
  for (let up = 0; up < 4; up++) {
    const candidate = path.join(dir, "promptTemplates.json");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback to the file next to this compiled module (server/dist/src).
  const here = path.dirname(fileURLToPath(import.meta.url));
  const beside = path.resolve(here, "../../promptTemplates.json");
  return fs.existsSync(beside) ? beside : null;
}

let templatesCache: PromptTemplate[] | null = null;

export function loadPromptTemplates(): PromptTemplate[] {
  if (templatesCache) return templatesCache;
  const file = findTemplatesFile();
  if (!file) {
    templatesCache = [];
    return templatesCache;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as PromptTemplate[];
    templatesCache = Array.isArray(raw)
      ? raw.map((t) => ({
          id: t.id,
          description: t.description ?? "",
          promptText: t.promptText,
          variables: t.variables ?? [],
        }))
      : [];
  } catch (e) {
    console.warn(`Failed to parse ${file}, falling back to empty list:`, e);
    templatesCache = [];
  }
  return templatesCache;
}

export function getPromptTemplate(id: string): PromptTemplate | null {
  return loadPromptTemplates().find((t) => t.id === id) ?? null;
}

/** Substitute {{var}} placeholders in the prompt text with provided values. */
export function resolveTemplate(
  template: PromptTemplate,
  variables: Record<string, string>,
): string {
  let out = template.promptText;
  for (const key of template.variables ?? []) {
    const value = variables[key] ?? "";
    out = out.replaceAll(`{{${key}}}`, value);
  }
  // Also substitute any stray {{...}} for keys not declared as variables.
  out = out.replace(/\{\{(\w+)\}\}/g, (_, name: string) => variables[name] ?? "");
  return out;
}
