export interface TavilyResult {
  title: string;
  url: string;
  content: string;
}

export interface TavilySearchResponse {
  answer?: string;
  results: TavilyResult[];
}

export interface TavilySearchOptions {
  apiKey: string | undefined;
  mock: boolean;
  maxResults?: number;
  /** "advanced" costs more credits but returns better-matched snippets. */
  searchDepth?: "basic" | "advanced";
  topic?: "general" | "news";
  /** Restrict results to recent pages. */
  timeRange?: "day" | "week" | "month" | "year";
  includeDomains?: string[];
  excludeDomains?: string[];
}

const TAVILY_BASE = "https://api.tavily.com";

export async function tavilySearch(
  query: string,
  opts: TavilySearchOptions,
  signal?: AbortSignal,
): Promise<TavilySearchResponse> {
  if (opts.mock) {
    return {
      answer: `Mock answer for: ${query}`,
      results: [
        { title: "Mock result", url: "https://example.com", content: `Mock content about ${query}` },
      ],
    };
  }
  if (!opts.apiKey) throw new Error("TAVILY_API_KEY is not set");
  const body: Record<string, unknown> = {
    query,
    search_depth: opts.searchDepth ?? "basic",
    include_answer: true,
    max_results: Math.min(Math.max(opts.maxResults ?? 5, 1), 20),
  };
  if (opts.topic) body.topic = opts.topic;
  if (opts.timeRange) body.time_range = opts.timeRange;
  if (opts.includeDomains?.length) body.include_domains = opts.includeDomains;
  if (opts.excludeDomains?.length) body.exclude_domains = opts.excludeDomains;
  const res = await fetch(`${TAVILY_BASE}/search`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: signal ?? null,
  });
  if (!res.ok) {
    throw new Error(`Tavily search failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as TavilySearchResponse;
  return { answer: data.answer, results: data.results ?? [] };
}

export interface TavilyExtractResult {
  url: string;
  rawContent: string;
}

export interface TavilyExtractResponse {
  results: TavilyExtractResult[];
  failed: { url: string; error: string }[];
}

/** Fetch pages' main text (markdown-ish) without a browser. */
export async function tavilyExtract(
  urls: string[],
  opts: { apiKey: string | undefined; mock: boolean; depth?: "basic" | "advanced" },
  signal?: AbortSignal,
): Promise<TavilyExtractResponse> {
  if (opts.mock) {
    return { results: urls.map((url) => ({ url, rawContent: `Mock page text for ${url}` })), failed: [] };
  }
  if (!opts.apiKey) throw new Error("TAVILY_API_KEY is not set");
  const res = await fetch(`${TAVILY_BASE}/extract`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify({ urls, extract_depth: opts.depth ?? "basic", format: "markdown" }),
    signal: signal ?? null,
  });
  if (!res.ok) {
    throw new Error(`Tavily extract failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as {
    results?: { url: string; raw_content?: string }[];
    failed_results?: { url: string; error?: string }[];
  };
  return {
    results: (data.results ?? []).map((r) => ({ url: r.url, rawContent: r.raw_content ?? "" })),
    failed: (data.failed_results ?? []).map((f) => ({ url: f.url, error: f.error ?? "failed" })),
  };
}
