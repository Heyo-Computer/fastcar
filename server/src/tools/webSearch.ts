import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { Config } from "../config.js";
import { tavilyExtract, tavilySearch } from "../services/tavily.js";

/** Per-page cap for web_extract, so one long page can't flood the context. */
export const EXTRACT_MAX_CHARS_PER_PAGE = 12_000;

export function createWebSearchTool(cfg: Config) {
  return defineTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web (Tavily). Returns a short answer plus the top results with URLs and content snippets. " +
      "Use include_domains to search within particular sites (e.g. a company's own site, or a directory), " +
      "topic=news with time_range for recent events, and search_depth=advanced when basic snippets are too thin.",
    parameters: Type.Object({
      query: Type.String({ description: "The search query" }),
      max_results: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "How many results (default 5, max 20)" })),
      search_depth: Type.Optional(StringEnum(["basic", "advanced"], { description: "Default basic" })),
      topic: Type.Optional(StringEnum(["general", "news"], { description: "Default general" })),
      time_range: Type.Optional(StringEnum(["day", "week", "month", "year"], { description: "Only pages from this recent window" })),
      include_domains: Type.Optional(Type.Array(Type.String(), { description: "Only results from these domains" })),
      exclude_domains: Type.Optional(Type.Array(Type.String(), { description: "Never results from these domains" })),
    }),
    execute: async (_toolCallId, params, signal) => {
      const { answer, results } = await tavilySearch(
        params.query,
        {
          apiKey: cfg.tavilyApiKey,
          mock: cfg.mock,
          maxResults: params.max_results,
          searchDepth: params.search_depth as "basic" | "advanced" | undefined,
          topic: params.topic as "general" | "news" | undefined,
          timeRange: params.time_range as "day" | "week" | "month" | "year" | undefined,
          includeDomains: params.include_domains,
          excludeDomains: params.exclude_domains,
        },
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

export function createWebExtractTool(cfg: Config) {
  return defineTool({
    name: "web_extract",
    label: "Web Extract",
    description:
      "Fetch the main text of up to 5 web pages (Tavily extract) without opening a browser — fast for reading " +
      "company sites, team/about pages, blog posts and job listings. Each page is capped at " +
      `${EXTRACT_MAX_CHARS_PER_PAGE.toLocaleString("en-US")} characters. Use the browser tools instead for pages ` +
      "that need clicking, scrolling or a login.",
    parameters: Type.Object({
      urls: Type.Array(Type.String(), { minItems: 1, maxItems: 5, description: "Page URLs (1-5)" }),
      depth: Type.Optional(StringEnum(["basic", "advanced"], { description: "advanced also reads tables and embedded content; slower" })),
    }),
    execute: async (_toolCallId, params, signal) => {
      const urls = params.urls.slice(0, 5);
      const { results, failed } = await tavilyExtract(
        urls,
        { apiKey: cfg.tavilyApiKey, mock: cfg.mock, depth: params.depth as "basic" | "advanced" | undefined },
        signal,
      );
      const parts: string[] = [];
      for (const r of results) {
        let text = r.rawContent.trim();
        let note = "";
        if (text.length > EXTRACT_MAX_CHARS_PER_PAGE) {
          note = `\n\n[… truncated: ${text.length.toLocaleString("en-US")} characters in total]`;
          text = text.slice(0, EXTRACT_MAX_CHARS_PER_PAGE);
        }
        parts.push(`# ${r.url}\n\n${text || "(no text)"}${note}`);
      }
      for (const f of failed) parts.push(`# ${f.url}\n\nFailed: ${f.error}`);
      return {
        content: [{ type: "text", text: parts.join("\n\n---\n\n") || "Nothing extracted." }],
        details: { pages: results.length, failed: failed.length },
      };
    },
  });
}
