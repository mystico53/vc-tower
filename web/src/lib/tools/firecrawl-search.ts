import { env } from "@/lib/env";
import { classifyUpstreamError } from "./classify-error";
import type { ToolResult } from "./types";

// Firecrawl v2 /search: returns a ranked list of web results for a query.
// We use it to find a firm's real homepage when row.website is null or junk
// (e.g. a LinkedIn URL). No scrape — the decider picks one result and calls
// firecrawl_website in the next step.
// Cost: ~1¢ per search (Firecrawl search is billed per-request regardless
// of how many results come back).

export type SearchHit = { url: string; title: string; description: string };

export async function searchWeb(query: string, limit = 8): Promise<ToolResult> {
  const apiKey = env.FIRECRAWL_API_KEY;

  let res: Response;
  try {
    res = await fetch("https://api.firecrawl.dev/v2/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        query,
        limit,
        sources: ["web"],
      }),
    });
  } catch (e) {
    return {
      ok: false,
      cost_cents: 0,
      raw: null,
      error: `firecrawl search network error: ${(e as Error).message}`,
      error_kind: "network",
    };
  }

  const body = await res.json().catch(() => ({}));

  if (!res.ok) {
    const bodyStr = JSON.stringify(body);
    return {
      ok: false,
      cost_cents: 0,
      raw: body,
      error: `firecrawl search ${res.status}: ${bodyStr.slice(0, 300)}`,
      raw_source: "firecrawl",
      error_kind: classifyUpstreamError(res.status, bodyStr),
    };
  }

  const bodyObj = (body ?? {}) as {
    success?: boolean;
    code?: string;
    error?: string;
    data?: unknown;
  };
  if (bodyObj.success === false) {
    const code = typeof bodyObj.code === "string" ? bodyObj.code : "unknown";
    const errText = typeof bodyObj.error === "string" ? bodyObj.error : JSON.stringify(body).slice(0, 300);
    return {
      ok: false,
      cost_cents: 0,
      raw: body,
      error: `firecrawl search ${code}: ${errText.slice(0, 200)}`,
      raw_source: "firecrawl",
      error_kind: "other",
    };
  }

  const hits = parseHits(bodyObj.data);

  // An empty result set is not a tool error — we still bill and let the
  // decider decide what to do next (usually: stop with no_useful_tools if
  // nothing else has inputs). But if the API returned literally zero hits,
  // mark cost_cents:0 — most providers don't bill empty searches.
  return {
    ok: true,
    cost_cents: hits.length > 0 ? 1 : 0,
    raw: body,
    markdown: formatHitsAsMarkdown(query, hits),
    raw_source: "firecrawl",
  };
}

// Firecrawl v2 search has returned the hits array in two shapes across
// API revisions: `data: [...]` (flat) and `data: { web: [...] }` (sources).
// Accept either.
export function parseHits(data: unknown): SearchHit[] {
  const asArray = (arr: unknown): SearchHit[] => {
    if (!Array.isArray(arr)) return [];
    return arr.flatMap((x): SearchHit[] => {
      if (!x || typeof x !== "object") return [];
      const obj = x as { url?: unknown; title?: unknown; description?: unknown; snippet?: unknown };
      const url = typeof obj.url === "string" ? obj.url : null;
      if (!url || !/^https?:\/\//i.test(url)) return [];
      const title = typeof obj.title === "string" ? obj.title : "";
      const description =
        typeof obj.description === "string"
          ? obj.description
          : typeof obj.snippet === "string"
            ? obj.snippet
            : "";
      return [{ url, title, description }];
    });
  };
  if (Array.isArray(data)) return asArray(data);
  if (data && typeof data === "object") {
    const d = data as { web?: unknown };
    if (Array.isArray(d.web)) return asArray(d.web);
  }
  return [];
}

function formatHitsAsMarkdown(query: string, hits: SearchHit[]): string {
  if (hits.length === 0) return `# Search: ${query}\n\n(no results)\n`;
  const lines = [`# Search: ${query}`, ""];
  for (const h of hits) {
    lines.push(`- [${h.title || h.url}](${h.url})`);
    if (h.description) lines.push(`  ${h.description}`);
  }
  return lines.join("\n");
}
