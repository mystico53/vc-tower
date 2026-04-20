import { env } from "@/lib/env";
import { scrapeWithJina } from "./jina";
import type { ToolResult } from "./types";

// Firecrawl v2 /scrape: returns LLM-friendly markdown for a single URL.
// Cost: ~1¢ per successful page (rough).
// On 429, 5xx, or network error, falls back to Jina (free) and flags raw_source.
// 5xx includes Firecrawl's internal proxy/tunnel errors (SCRAPE_SITE_ERROR,
// ERR_TUNNEL_CONNECTION_FAILED) which are transient and typically succeed via
// Jina's independent fetch path.
export async function scrapeWebsite(url: string): Promise<ToolResult> {
  const apiKey = env.FIRECRAWL_API_KEY;

  let res: Response;
  try {
    res = await fetch("https://api.firecrawl.dev/v2/scrape", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        url,
        formats: ["markdown", "links"],
        // Include nav + footer so /team, /portfolio, /about links on Squarespace-
        // style sites actually show up in `links`. Slightly noisier markdown, but
        // the extractor tolerates it and the orchestrator needs those URLs.
        onlyMainContent: false,
      }),
    });
  } catch (e) {
    // Network failure — fall back to Jina.
    const fallback = await scrapeWithJina(url);
    return {
      ...fallback,
      error: fallback.ok ? undefined : `firecrawl network error + jina failed: ${(e as Error).message}`,
    };
  }

  if (res.status === 429 || res.status >= 500) {
    // Rate limit or transient Firecrawl proxy/tunnel error — fall back to Jina.
    const fallback = await scrapeWithJina(url);
    if (!fallback.ok) {
      return {
        ...fallback,
        error: `firecrawl ${res.status} + jina failed: ${fallback.error ?? "unknown"}`,
      };
    }
    return fallback;
  }

  const body = await res.json().catch(() => ({}));

  if (!res.ok) {
    return {
      ok: false,
      cost_cents: 0,
      raw: body,
      error: `firecrawl ${res.status}: ${JSON.stringify(body).slice(0, 300)}`,
      raw_source: "firecrawl",
    };
  }

  // Firecrawl success. Response shape: { success: true, data: { markdown, metadata, ... } }
  const data = (body as { data?: { markdown?: string } }).data ?? {};
  const markdown = typeof data.markdown === "string" ? data.markdown : "";

  return {
    ok: true,
    cost_cents: 1,
    raw: body,
    markdown,
    raw_source: "firecrawl",
  };
}
