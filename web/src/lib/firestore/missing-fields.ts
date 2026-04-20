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

export type ScrapeStatus = "complete" | "partial" | "dead_site" | "error_only" | null;

export type ScrapeStatusResult = {
  status: ScrapeStatus;
  reason: string | null;
};

// Map a noisy tool error_message down to a 1–3-word tag for the UI badge.
// Order matters: more specific matches first. Returns null when nothing fits.
function summarizeError(msg: string | null | undefined): string | null {
  if (!msg) return null;
  const m = msg.toLowerCase();
  if (m.includes("err_empty_response")) return "empty response";
  if (m.includes("err_tunnel_connection_failed")) return "proxy error";
  if (m.includes("err_name_not_resolved") || m.includes("getaddrinfo") || m.includes("dns"))
    return "DNS error";
  if (m.includes("err_cert") || m.includes("certificate") || m.includes("ssl"))
    return "cert error";
  if (m.includes("err_connection_refused")) return "connection refused";
  if (m.includes("err_connection_timed_out") || m.includes("timeout")) return "timeout";
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
export function computeScrapeStatus(args: {
  missing: MissingField[];
  steps: Array<{
    status: string;
    chosen_tool: string | null;
    extracted_count: number;
    error_message?: string | null;
  }>;
}): ScrapeStatusResult {
  if (args.steps.length === 0) return { status: null, reason: null };
  if (args.missing.length === 0) return { status: "complete", reason: null };

  const nonStopSteps = args.steps.filter((s) => s.chosen_tool !== null);
  if (nonStopSteps.length === 0) return { status: "partial", reason: null };

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
    // Distinguish "sites that errored" vs "sites that returned empty markdown"
    // — the former is transient, the latter is usually JS-rendered.
    const anyErrored = nonStopSteps.some((s) => s.status === "error");
    return { status: "dead_site", reason: anyErrored ? "errors + empty" : "empty pages" };
  }

  return { status: "partial", reason: null };
}
