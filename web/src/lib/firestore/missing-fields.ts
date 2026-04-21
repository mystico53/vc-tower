import type { MissingField, Row } from "./schema";

// Port of Investor.missing_fields() in scripts/build_masterlist.py:690-704.
// Must stay byte-for-byte equivalent with the Python logic so a row's
// missing_fields list doesn't diverge between ingest and orchestrator.
export function computeMissingFields(
  row: Pick<
    Row,
    | "stages"
    | "sectors_l1"
    | "check_min_usd"
    | "check_max_usd"
    | "thesis"
    | "email"
    | "linkedin"
    | "website"
    | "countries_invest"
    | "hq_country"
  >,
): MissingField[] {
  const missing: MissingField[] = [];
  if (!row.stages || row.stages.length === 0) missing.push("stages");
  if (!row.sectors_l1 || row.sectors_l1.length === 0) missing.push("sectors");
  if (row.check_min_usd == null && row.check_max_usd == null) missing.push("check_range");
  if (!row.thesis) missing.push("thesis");
  if (!row.email && !row.linkedin && !row.website) missing.push("any_contact");
  if ((!row.countries_invest || row.countries_invest.length === 0) && !row.hq_country) {
    missing.push("geo");
  }
  return missing;
}

// Score 0..100 derived from the 6 MissingField buckets. 0 = all buckets
// missing, 100 = all filled. Matches the Python ingest's convention so a row
// that lands already-complete on ingest stays at 100 through re-computation.
const TOTAL_MISSING_BUCKETS = 6;
export function computeCompletenessScore(missing: MissingField[]): number {
  const filled = Math.max(0, TOTAL_MISSING_BUCKETS - missing.length);
  return Math.round((100 * filled) / TOTAL_MISSING_BUCKETS);
}

export type ScrapeStatus =
  | "complete"
  | "partial"
  | "dead_site"
  | "error_only"
  | "stuck_at_cap"
  | "dead_letter"
  | null;

export type ScrapeStatusResult = {
  status: ScrapeStatus;
  reason: string | null;
};

// Map a noisy tool error_message down to a 1–3-word tag for the UI badge.
// Order matters: more specific matches first. Returns null when nothing fits.
function summarizeError(msg: string | null | undefined): string | null {
  if (!msg) return null;
  const m = msg.toLowerCase();
  // Classified-content error_kinds (from classifyContent() in tools/): these
  // are the "200 OK but useless" signals. Check before generic markers so we
  // surface the specific reason to the UI.
  if (m.includes("auth_wall")) return "auth wall";
  if (m.includes("js_required")) return "js required";
  if (m.includes("empty_content")) return "empty content";
  if (m.includes("err_empty_response")) return "empty response";
  if (m.includes("err_tunnel_connection_failed")) return "proxy error";
  if (m.includes("err_name_not_resolved") || m.includes("getaddrinfo") || m.includes("dns"))
    return "DNS error";
  if (m.includes("scrape_dns_resolution_error") || m.includes("dead_host")) return "host unreachable";
  if (m.includes("err_cert") || m.includes("certificate") || m.includes("ssl"))
    return "cert error";
  if (m.includes("err_connection_refused")) return "connection refused";
  if (m.includes("err_connection_timed_out") || m.includes("timeout")) return "timeout";
  // Both upstreams failed on the same URL — origin is the real problem
  // (unreachable, blocking bots, or broken) rather than our vendors. Shown
  // before the generic 4xx/5xx matcher so "firecrawl 500 + jina 422" resolves
  // to a user-facing cause, not to plumbing status codes.
  if (/firecrawl\s+\d+.*jina/i.test(m) || /jina.*firecrawl\s+\d+/i.test(m)) return "site unreachable";
  // Origin returned a real status code via firecrawl's proxy — report what
  // the site itself actually did.
  const originMatch = m.match(/origin\s+([45]\d\d)/);
  if (originMatch) return originMatch[1] === "404" ? "404 not found" : `origin ${originMatch[1]}`;
  // First HTTP status code anywhere in the message wins. Chained errors
  // ("firecrawl 500 + jina 422") should report the upstream (500) root cause,
  // not the fallback's follow-on status.
  const codeMatch = m.match(/(?:^|\W)([45]\d\d)(?:\W|$)/);
  if (codeMatch) return codeMatch[1].startsWith("4") ? "4xx blocked" : "5xx error";
  if (m.includes("scrape_site_error")) return "scrape failed";
  if (m.includes("budget")) return "budget";
  if (m.includes("extract failed")) return "extract failed";
  return null;
}

// Classify a row's current enrichment state from its step history + missing
// fields. Returns status plus a short human-readable reason for the badge
// tooltip/subtitle so the UI can surface WHY a row is flagged without
// forcing the user to open the step log.
//
// Optional cap / streak counters let this function surface the terminal
// states that depend on external knowledge:
//   total_steps + step_cap  → stuck_at_cap (hit the per-row step limit)
//   zero_progress_streak + dead_letter_streak → dead_letter (N empty batches)
// Callers that don't supply those still get back the original statuses.
// dead_letter takes priority over stuck_at_cap — a row that's both stuck and
// repeatedly empty should be filtered out of the candidate pool, not merely
// flagged for manual intervention.
export function computeScrapeStatus(args: {
  missing: MissingField[];
  steps: Array<{
    status: string;
    chosen_tool: string | null;
    extracted_count: number;
    error_message?: string | null;
  }>;
  total_steps?: number;
  step_cap?: number;
  zero_progress_streak?: number;
  dead_letter_streak?: number;
}): ScrapeStatusResult {
  if (args.steps.length === 0) return { status: null, reason: null };
  if (args.missing.length === 0) return { status: "complete", reason: null };

  const nonStopSteps = args.steps.filter((s) => s.chosen_tool !== null);
  if (nonStopSteps.length === 0) return { status: "partial", reason: null };

  // Dead-letter: more than DEAD_LETTER_STREAK batches in a row have merged
  // nothing. Drops the row from the candidate pool until an operator resets
  // the streak or clears the missing_fields some other way.
  if (
    typeof args.zero_progress_streak === "number" &&
    typeof args.dead_letter_streak === "number" &&
    args.zero_progress_streak >= args.dead_letter_streak
  ) {
    return {
      status: "dead_letter",
      reason: `${args.zero_progress_streak} empty batches`,
    };
  }

  // Stuck at cap: every step was consumed but fields remain. We check this
  // after the partial-null-with-only-stops guard so a row that's only ever
  // seen "stop" steps doesn't falsely claim stuck_at_cap. Only applies when
  // the caller supplied both counters.
  if (
    typeof args.total_steps === "number" &&
    typeof args.step_cap === "number" &&
    args.total_steps >= args.step_cap
  ) {
    return { status: "stuck_at_cap", reason: "cap reached" };
  }

  const allErrored = nonStopSteps.every((s) => s.status === "error");
  if (allErrored) {
    // Reason = the most recent error summarized. Latest error tends to be
    // what the user most recently saw and the most likely root cause.
    const last = [...nonStopSteps].reverse().find((s) => s.status === "error");
    return { status: "error_only", reason: summarizeError(last?.error_message) ?? "scrape failed" };
  }

  // Dead-site: at least 2 real steps ran, every one extracted nothing.
  const zeroExtracting = nonStopSteps.filter((s) => s.extracted_count === 0);
  if (nonStopSteps.length >= 2 && zeroExtracting.length === nonStopSteps.length) {
    // If every step reports the same classified content kind (auth_wall /
    // js_required / empty_content from classifyContent()), surface that as
    // the dead_site reason instead of the generic "empty pages". Gives the
    // operator a specific remediation signal — auth_wall needs an account,
    // js_required needs a JS-rendering tool, empty_content is just dead.
    const kindTags = nonStopSteps
      .map((s) => summarizeError(s.error_message))
      .filter((t): t is string => t === "auth wall" || t === "js required" || t === "empty content");
    if (kindTags.length === nonStopSteps.length && new Set(kindTags).size === 1) {
      return { status: "dead_site", reason: kindTags[0] };
    }
    // Distinguish "sites that errored" vs "sites that returned empty markdown"
    // — the former is transient, the latter is usually JS-rendered.
    const anyErrored = nonStopSteps.some((s) => s.status === "error");
    return { status: "dead_site", reason: anyErrored ? "errors + empty" : "empty pages" };
  }

  return { status: "partial", reason: null };
}
