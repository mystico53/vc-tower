import { scrapeWebsite } from "./firecrawl";
import type { ToolResult } from "./types";

// VCSheet uses firm-name-based slugs: "Amplo" → "amplo", "Andreessen Horowitz"
// → "andreessen-horowitz". If the guess misses, Firecrawl returns origin 404
// and decide() will stop — the caller treats that as "no structured data
// available" rather than retrying.
export function vcsheetSlug(name: string): string | null {
  const cleaned = name
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9\s-]/g, " ")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return cleaned.length > 0 ? cleaned : null;
}

// Look up stages + check range on VCSheet — the public VC directory that
// exposes both fields structurally. Thin wrapper over scrapeWebsite: the
// extractor pulls "Pre-Seed / Seed / Series A" stage chips and "$500K–$3M"
// check-size strings out of the rendered markdown. Origin 404 (slug miss)
// surfaces as error_kind: "other", treated as a dead end by the orchestrator.
export async function lookupOnVcsheet(firmName: string): Promise<ToolResult> {
  const slug = vcsheetSlug(firmName);
  if (!slug) {
    return {
      ok: false,
      cost_cents: 0,
      raw: null,
      error: "vcsheet: firm_name produced empty slug",
      error_kind: "other",
    };
  }
  const url = `https://www.vcsheet.com/fund/${slug}`;
  const res = await scrapeWebsite(url);
  return { ...res, raw_source: "vcsheet" };
}
