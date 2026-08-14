export interface TavilyResult {
  title: string;
  url: string;
  content: string;
}

export interface TavilySearchResponse {
  answer?: string;
  results: TavilyResult[];
}

export async function tavilySearch(
  query: string,
  opts: { apiKey: string | undefined; mock: boolean; maxResults?: number },
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
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify({
      query,
      search_depth: "basic",
      include_answer: true,
      max_results: opts.maxResults ?? 5,
    }),
    signal: signal ?? null,
  });
  if (!res.ok) {
    throw new Error(`Tavily search failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as TavilySearchResponse;
  return { answer: data.answer, results: data.results ?? [] };
}
