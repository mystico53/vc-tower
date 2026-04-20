import type { ToolResult } from "./types";

// Free fallback when Firecrawl is rate-limited. Jina Reader converts any
// URL to LLM-friendly markdown via a simple GET.
export async function scrapeWithJina(url: string): Promise<ToolResult> {
  const target = `https://r.jina.ai/${url}`;
  try {
    const res = await fetch(target, {
      headers: { Accept: "text/plain" },
    });
    const body = await res.text();
    if (!res.ok) {
      return {
        ok: false,
        cost_cents: 0,
        raw: { status: res.status, body: body.slice(0, 500) },
        error: `jina ${res.status}`,
        raw_source: "jina",
      };
    }
    return {
      ok: true,
      cost_cents: 0,
      raw: { status: res.status, body },
      markdown: body,
      raw_source: "jina",
    };
  } catch (e) {
    return {
      ok: false,
      cost_cents: 0,
      raw: null,
      error: `jina fetch failed: ${(e as Error).message}`,
      raw_source: "jina",
    };
  }
}
