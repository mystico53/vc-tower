import { env } from "@/lib/env";
import type { ToolResult } from "./types";

// Apify actor input shapes vary by scraper. Most LinkedIn scrapers accept
// either `profileUrls` / `urls` or `startUrls`. We send both keys to be
// compatible with supreme_coder/linkedin-profile-scraper and the major
// alternatives without forking by actor.
function buildInput(url: string): Record<string, unknown> {
  return {
    urls: [url],
    profileUrls: [url],
    startUrls: [{ url }],
  };
}

async function runActor(actorId: string, url: string, pricePerProfileCents: number): Promise<ToolResult> {
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
      error: `apify ${res.status}: ${text.slice(0, 300)}`,
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

  return {
    ok: true,
    cost_cents: pricePerProfileCents,
    raw: body,
  };
}

export async function scrapeLinkedInProfile(url: string): Promise<ToolResult> {
  return runActor(env.APIFY_LINKEDIN_PROFILE_ACTOR, url, 1);
}

export async function scrapeLinkedInCompany(url: string): Promise<ToolResult> {
  return runActor(env.APIFY_LINKEDIN_COMPANY_ACTOR, url, 1);
}
