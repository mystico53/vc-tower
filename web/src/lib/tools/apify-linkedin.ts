import { env } from "@/lib/env";
import { classifyUpstreamError } from "./classify-error";
import type { ToolResult } from "./types";

// Normalize to the form Apify's strict URL validators accept: https + www +
// trailing slash. Bare "linkedin.com/in/<slug>" or no trailing slash gets
// 400 "Items in input.urls ... do not contain valid URLs" from the profile
// actor (supreme_coder/linkedin-profile-scraper).
function normalizeLinkedInUrl(url: string): string {
  let out = url.trim();
  if (!/^https?:\/\//i.test(out)) out = `https://${out}`;
  out = out.replace(/^http:\/\//i, "https://");
  out = out.replace(/^https:\/\/(?!www\.)linkedin\.com/i, "https://www.linkedin.com");
  // Strip query/hash then ensure exactly one trailing slash.
  out = out.split(/[?#]/)[0];
  if (!out.endsWith("/")) out = `${out}/`;
  return out;
}

// Per-actor input shapes. Shotgun-ing all possible keys can trip strict
// validators (seen on supreme_coder/linkedin-profile-scraper). data-slayer's
// company scraper reads `linkedin_url` and silently falls back to Google
// without it; supreme_coder's profile scraper reads `urls` only.
function buildProfileInput(url: string): Record<string, unknown> {
  return { urls: [{ url }] };
}
function buildCompanyInput(url: string): Record<string, unknown> {
  return { linkedin_url: url };
}

// Pull the slug segment from a LinkedIn URL, e.g. "watertowerventures"
// from https://www.linkedin.com/company/watertowerventures/.
function linkedInSlug(url: string): string | null {
  const m = url.match(/linkedin\.com\/(?:company|in|school)\/([^/?#]+)/i);
  return m ? m[1].toLowerCase() : null;
}

// Guard against the Google-fallback class of bugs: the actor returns 200
// with a full payload that belongs to a different company than we asked for.
function returnedSlugMismatches(items: unknown[], expectedSlug: string | null): string | null {
  if (!expectedSlug || items.length === 0) return null;
  const first = items[0] as Record<string, unknown> | undefined;
  if (!first || typeof first !== "object") return null;
  const candidates: string[] = [];
  if (typeof first.universal_name_id === "string") candidates.push(first.universal_name_id.toLowerCase());
  if (typeof first.public_identifier === "string") candidates.push(first.public_identifier.toLowerCase());
  if (typeof first.url === "string") {
    const s = linkedInSlug(first.url);
    if (s) candidates.push(s);
  }
  if (candidates.length === 0) return null;
  return candidates.includes(expectedSlug) ? null : candidates[0];
}

async function runActor(
  actorId: string,
  rawUrl: string,
  pricePerProfileCents: number,
  buildInput: (url: string) => Record<string, unknown>,
): Promise<ToolResult> {
  const url = normalizeLinkedInUrl(rawUrl);
  const token = env.APIFY_TOKEN;
  const endpoint = `https://api.apify.com/v2/acts/${actorId.replace("/", "~")}/run-sync-get-dataset-items?token=${encodeURIComponent(token)}`;

  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildInput(url)),
    });
  } catch (e) {
    return {
      ok: false,
      cost_cents: 0,
      raw: null,
      error: `apify network error: ${(e as Error).message}`,
      error_kind: "network",
    };
  }

  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }

  if (!res.ok) {
    return {
      ok: false,
      cost_cents: 0,
      raw: body,
      error: `apify ${res.status} (sent url=${url}): ${text.slice(0, 300)}`,
      error_kind: classifyUpstreamError(res.status, text),
    };
  }

  // run-sync-get-dataset-items returns an array of items; at least one means
  // the actor produced data.
  const items = Array.isArray(body) ? body : [];
  if (items.length === 0) {
    return {
      ok: false,
      cost_cents: pricePerProfileCents,
      raw: body,
      error: "apify returned no dataset items",
    };
  }

  const expectedSlug = linkedInSlug(url);
  const wrongSlug = returnedSlugMismatches(items, expectedSlug);
  if (wrongSlug) {
    return {
      ok: false,
      cost_cents: pricePerProfileCents,
      raw: body,
      error: `apify returned wrong company: expected "${expectedSlug}", got "${wrongSlug}" (likely actor-default fallback)`,
      error_kind: "other",
    };
  }

  return {
    ok: true,
    cost_cents: pricePerProfileCents,
    raw: body,
  };
}

export async function scrapeLinkedInProfile(url: string): Promise<ToolResult> {
  return runActor(env.APIFY_LINKEDIN_PROFILE_ACTOR, url, 1, buildProfileInput);
}

export async function scrapeLinkedInCompany(url: string): Promise<ToolResult> {
  return runActor(env.APIFY_LINKEDIN_COMPANY_ACTOR, url, 1, buildCompanyInput);
}
