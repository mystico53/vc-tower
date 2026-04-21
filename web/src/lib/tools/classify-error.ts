import type { ToolErrorKind } from "./types";

// Classify an HTTP response from a paid upstream (Firecrawl, Apify, xAI,
// Dashscope) into an error_kind the orchestrator uses to decide whether to
// trip the global pause. The body string is the raw response text — we scan
// it for "insufficient credit" / "quota" / "balance" patterns because some
// providers return 400 or 403 with a credit message rather than 402.
export function classifyUpstreamError(
  status: number,
  body: string | null,
): ToolErrorKind {
  const msg = (body ?? "").toLowerCase();
  const looksLikeCredit =
    /insufficient\s+credit|insufficient\s+balance|out of credit|quota\s+exceeded|quota_exceeded|credit.*exhaust|payment\s+required|billing|balance.*low|no credits/i.test(
      msg,
    );
  if (looksLikeCredit) return "credit";
  if (status === 401 || status === 403) return "auth";
  if (status === 402) return "credit";
  if (status === 429) return "rate_limit";
  return "other";
}
