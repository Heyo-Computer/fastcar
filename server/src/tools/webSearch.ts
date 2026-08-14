import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { Config } from "../config.js";
import { tavilySearch } from "../services/tavily.js";

export function createWebSearchTool(cfg: Config) {
  return defineTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web (Tavily). Returns a short answer plus the top results with URLs and content snippets.",
    parameters: Type.Object({
      query: Type.String({ description: "The search query" }),
    }),
    execute: async (_toolCallId, params, signal) => {
      const { answer, results } = await tavilySearch(
        params.query,
        { apiKey: cfg.tavilyApiKey, mock: cfg.mock },
        signal,
      );
      const lines: string[] = [];
      if (answer) lines.push(`Answer: ${answer}`, "");
      for (const r of results) {
        lines.push(`## ${r.title}`, r.url, r.content, "");
      }
      return {
        content: [{ type: "text", text: lines.join("\n") || "No results." }],
        details: { resultCount: results.length },
      };
    },
  });
}
