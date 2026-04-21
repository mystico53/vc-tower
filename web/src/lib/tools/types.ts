// Every enrichment tool returns this shape. See docs/pr2.md:128-136.
export type ToolResult = {
  ok: boolean;
  cost_cents: number;
  raw: unknown;            // full provider response; stored on the step doc
  markdown?: string;       // filled by Firecrawl / Jina
  error?: string;
  raw_source?: string;     // e.g. "firecrawl" or "jina" when a fallback fires
  // When ok=false, classifies the failure. "credit" / "auth" are the
  // "halt everything" signals — the orchestrator trips the global pause doc so
  // other in-flight rows stop before burning more of a dead provider's quota.
  // Unset or "other" means one-off per-request failure; keep running.
  error_kind?: ToolErrorKind;
  // Structured context for the specific error. Persisted on the step doc so
  // the UI and the next decide() iteration can see why the tool refused —
  // not just a string to grep.
  error_detail?: Record<string, unknown>;
};

export type ToolErrorKind =
  | "credit"       // 402, "insufficient credit", quota exhausted
  | "auth"         // 401, invalid API key
  | "rate_limit"   // 429
  | "network"      // fetch threw
  | "dead_host"    // DNS resolution failed / hostname unreachable — every subpath on this host is doomed
  | "invented_url" // orchestrator asked to scrape a URL whose host wasn't from row.website / discovered_links / urls_scraped. Short-circuited before we spent a Firecrawl call.
  | "other";       // 400/404/5xx/empty-result — not fatal to the run

// Which error kinds should trip the global pause. Exported so the orchestrator
// and any future call site agree on the policy in one place.
export const PAUSE_ON_KINDS: ReadonlySet<ToolErrorKind> = new Set(["credit", "auth"]);

export type ToolName =
  | "firecrawl_website"
  | "web_search"
  | "linkedin_profile"
  | "linkedin_company"
  | "grok_x_lookup";
