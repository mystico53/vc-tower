import { env } from "@/lib/env";
import { classifyUpstreamError } from "./classify-error";
import { classifyContent } from "./classify-content";
import { scrapeWithJina } from "./jina";
import type { ToolResult } from "./types";

// A Jina success that returns empty-content / js_required / auth_wall markdown
// is no better than a firecrawl one — surface the same classified error_kind
// so decide() reacts the same way. Kept local to firecrawl.ts because Jina is
// only ever called as a firecrawl fallback.
function classifyJinaSuccess(fallback: ToolResult): ToolResult {
  if (!fallback.ok) return fallback;
  const kind = classifyContent(fallback.markdown);
  if (!kind) return fallback;
  return {
    ok: false,
    cost_cents: fallback.cost_cents,
    raw: fallback.raw,
    error: `jina ${kind}`,
    raw_source: "jina",
    error_kind: kind,
  };
}

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
    const fallback = classifyJinaSuccess(await scrapeWithJina(url));
    return {
      ...fallback,
      error: fallback.ok ? undefined : `firecrawl network error + jina failed: ${(e as Error).message}`,
      error_kind: fallback.ok ? undefined : fallback.error_kind ?? "network",
    };
  }

  if (res.status === 429 || res.status >= 500) {
    // Rate limit or transient Firecrawl proxy/tunnel error — fall back to Jina.
    const fallback = classifyJinaSuccess(await scrapeWithJina(url));
    if (!fallback.ok) {
      return {
        ...fallback,
        error: `firecrawl ${res.status} + jina ${fallback.error_kind ?? "failed"}: ${fallback.error ?? "unknown"}`,
      };
    }
    return fallback;
  }

  const body = await res.json().catch(() => ({}));

  if (!res.ok) {
    const bodyStr = JSON.stringify(body);
    return {
      ok: false,
      cost_cents: 0,
      raw: body,
      error: `firecrawl ${res.status}: ${bodyStr.slice(0, 300)}`,
      raw_source: "firecrawl",
      error_kind: classifyUpstreamError(res.status, bodyStr),
    };
  }

  // Firecrawl sometimes returns HTTP 200 with { success: false, code, error } in
  // the body — DNS failures, tunnel errors, etc. Without this check we'd bill a
  // cent and hand the extractor empty markdown, and the decider would happily
  // retry sibling subpaths on the same unreachable host.
  const bodyObj = (body ?? {}) as { success?: boolean; code?: string; error?: string; data?: { markdown?: string } };
  if (bodyObj.success === false) {
    const code = typeof bodyObj.code === "string" ? bodyObj.code : "unknown";
    const errText = typeof bodyObj.error === "string" ? bodyObj.error : JSON.stringify(body).slice(0, 300);
    // DNS failures are terminal for the whole hostname — Jina would hit the
    // same resolver. Skip fallback and surface dead_host so the orchestrator
    // can blacklist the host.
    if (code === "SCRAPE_DNS_RESOLUTION_ERROR") {
      let host: string | null = null;
      try {
        host = new URL(url).hostname.toLowerCase();
      } catch {
        // url was somehow unparseable — still surface the error, just without host detail
      }
      return {
        ok: false,
        cost_cents: 0,
        raw: body,
        // Don't truncate — firecrawl's full message includes "Possible causes:
        // (1) typo, (2) new domain, (3) DNS misconfig" which is useful context
        // when eyeballing failures. failStep caps at 2000 chars anyway.
        error: `firecrawl ${code}: ${errText}`,
        raw_source: "firecrawl",
        error_kind: "dead_host",
        error_detail: host ? { host } : undefined,
      };
    }
    // Other in-body failures (site errors, tunnel issues) — try Jina before
    // giving up, same as with 5xx.
    const fallback = classifyJinaSuccess(await scrapeWithJina(url));
    if (fallback.ok) return fallback;
    return {
      ok: false,
      cost_cents: 0,
      raw: body,
      error: `firecrawl ${code}: ${errText.slice(0, 200)} + jina ${fallback.error_kind ?? "failed"}: ${fallback.error ?? "unknown"}`,
      raw_source: "firecrawl",
      error_kind: fallback.error_kind ?? "other",
    };
  }

  // Firecrawl success. Response shape: { success: true, data: { markdown, metadata, ... } }
  const data = (bodyObj.data ?? {}) as {
    markdown?: string;
    metadata?: { statusCode?: number };
  };
  const markdown = typeof data.markdown === "string" ? data.markdown : "";
  const originStatus = typeof data.metadata?.statusCode === "number" ? data.metadata.statusCode : null;

  // Firecrawl proxied successfully but the origin returned an error page.
  // Without this check, a 404 landing on every subpath (e.g. silkcapital.net)
  // reads to us as "scrape worked, page empty" — we bill 1¢ and the decider
  // keeps guessing /about, /team, /thesis, burning budget on a broken host.
  // Firecrawl does bill for origin 4xx, so we keep cost_cents:1 to reflect real spend.
  if (originStatus !== null && originStatus >= 400) {
    return {
      ok: false,
      cost_cents: 1,
      raw: body,
      error: `firecrawl origin ${originStatus}`,
      raw_source: "firecrawl",
      error_kind: "other",
    };
  }

  // Classify "200 OK but useless" cases. A page that Firecrawl fetched
  // without error but returned near-empty, login-walled, or JS-stub markdown
  // is either (a) JS-rendered and needs a different tool, (b) paywalled, or
  // (c) a redirect stub. Surface a specific error_kind so decide() can pivot
  // tools on the first hit instead of burning the 2-zero-extraction dead-site
  // cycle before giving up. Firecrawl still billed 1¢, so cost_cents stays.
  const contentKind = classifyContent(markdown);
  if (contentKind) {
    return {
      ok: false,
      cost_cents: 1,
      raw: body,
      error: `firecrawl ${contentKind}`,
      raw_source: "firecrawl",
      error_kind: contentKind,
    };
  }

  return {
    ok: true,
    cost_cents: 1,
    raw: body,
    markdown,
    raw_source: "firecrawl",
  };
}
