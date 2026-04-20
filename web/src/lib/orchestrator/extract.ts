import OpenAI from "openai";
import { z } from "zod";
import { env } from "@/lib/env";
import type { MissingField, Row } from "@/lib/firestore/schema";
import { isCanonicalSectorL1, isCanonicalStage } from "./canonical";
import { EXTRACT_SYSTEM_PROMPT } from "./prompts";

const FieldDelta = z.object({
  value: z.unknown(),
  confidence: z.number().min(0).max(1),
  evidence_quote: z.string().nullable().optional(),
});
export type FieldDelta = z.infer<typeof FieldDelta>;

// Every field the extractor is allowed to fill. The shape mirrors the Row
// schema; step-writer merges fields with confidence >= 0.5 back into the row.
export const ExtractedDelta = z
  .object({
    stages: FieldDelta,
    sectors_l1: FieldDelta,
    thesis: FieldDelta,
    check_min_usd: FieldDelta,
    check_max_usd: FieldDelta,
    hq_country: FieldDelta,
    countries_invest: FieldDelta,
    email: FieldDelta,
    linkedin: FieldDelta,
    website: FieldDelta,
    twitter: FieldDelta,
    partners: FieldDelta,
    portfolio_companies: FieldDelta,
    x_voice_summary: FieldDelta,
    x_recent_posts: FieldDelta,
  })
  .partial();
export type ExtractedDelta = z.infer<typeof ExtractedDelta>;

const EXTRACTABLE_KEYS = [
  "stages",
  "sectors_l1",
  "thesis",
  "check_min_usd",
  "check_max_usd",
  "hq_country",
  "countries_invest",
  "email",
  "linkedin",
  "website",
  "twitter",
  "partners",
  "portfolio_companies",
  "x_voice_summary",
  "x_recent_posts",
] as const;

// Qwen sometimes drops the {value, confidence, evidence_quote} envelope for
// array-valued fields (emits a bare string[] / object[] instead). And on the
// first try it tends to emit stray keys like "name" / "firm_name" that aren't
// in our schema. Coerce here: keep only the allowed keys, wrap bare values
// into a FieldDelta with a placeholder confidence so merge still applies.
function coerceExtractedDelta(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const input = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of EXTRACTABLE_KEYS) {
    const v = input[key];
    if (v === undefined || v === null) continue;
    if (
      typeof v === "object" &&
      !Array.isArray(v) &&
      "value" in (v as Record<string, unknown>) &&
      "confidence" in (v as Record<string, unknown>)
    ) {
      out[key] = v;
    } else {
      out[key] = { value: v, confidence: 0.7, evidence_quote: null };
    }
  }
  return out;
}

type ExtractorInput = {
  raw: unknown;                // tool output (markdown, JSON, etc.)
  markdown?: string;           // pre-flattened text if the tool exposes it
  missingFields: MissingField[];
  row: Pick<
    Row,
    | "name"
    | "firm_name"
    | "investor_type"
    | "website"
    | "linkedin"
    | "twitter"
    | "email"
    | "hq_country"
    | "thesis"
    | "stages"
    | "sectors_l1"
    | "check_min_usd"
    | "check_max_usd"
    | "countries_invest"
    | "partners"
    | "portfolio_companies"
  >;
};

function sourceText(input: ExtractorInput): string {
  if (input.markdown && input.markdown.trim().length > 0) return input.markdown;
  return JSON.stringify(input.raw, null, 2);
}

function buildClient(): OpenAI {
  return new OpenAI({
    apiKey: env.DASHSCOPE_API_KEY,
    baseURL: env.DASHSCOPE_BASE_URL,
  });
}

function userMessage(input: ExtractorInput, reminder: string | null): string {
  // Show every field the extractor is allowed to fill so the model can see
  // exactly which ones are empty and worth extracting vs. already filled
  // (where extraction only helps if it's strictly better evidence).
  const rowSummary = JSON.stringify(
    {
      name: input.row.name,
      firm_name: input.row.firm_name,
      investor_type: input.row.investor_type,
      website: input.row.website,
      linkedin: input.row.linkedin,
      twitter: input.row.twitter,
      email: input.row.email,
      hq_country: input.row.hq_country,
      countries_invest: input.row.countries_invest,
      stages: input.row.stages,
      sectors_l1: input.row.sectors_l1,
      check_min_usd: input.row.check_min_usd,
      check_max_usd: input.row.check_max_usd,
      thesis: input.row.thesis,
      partners: input.row.partners,
      portfolio_companies_count: input.row.portfolio_companies?.length ?? 0,
    },
    null,
    2,
  );

  const trimmedSource = sourceText(input).slice(0, 20_000);

  return [
    `Missing fields for this row: ${JSON.stringify(input.missingFields)}.`,
    "",
    "Row known values (do not contradict):",
    rowSummary,
    "",
    "Tool output to extract from:",
    "<<<SOURCE",
    trimmedSource,
    "SOURCE>>>",
    reminder ? `\nCorrection: ${reminder}` : "",
  ].join("\n");
}

async function callExtractor(
  client: OpenAI,
  input: ExtractorInput,
  reminder: string | null,
): Promise<string> {
  const res = await client.chat.completions.create({
    model: env.DASHSCOPE_MODEL,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: EXTRACT_SYSTEM_PROMPT },
      { role: "user", content: userMessage(input, reminder) },
    ],
  });
  return res.choices[0]?.message.content ?? "";
}

function stripNonCanonical(delta: ExtractedDelta): ExtractedDelta {
  const out: ExtractedDelta = { ...delta };

  if (out.stages && Array.isArray(out.stages.value)) {
    const filtered = (out.stages.value as unknown[]).filter(
      (x): x is string => typeof x === "string" && isCanonicalStage(x),
    );
    if (filtered.length === 0) delete out.stages;
    else out.stages = { ...out.stages, value: filtered };
  }

  if (out.sectors_l1 && Array.isArray(out.sectors_l1.value)) {
    const filtered = (out.sectors_l1.value as unknown[]).filter(
      (x): x is string => typeof x === "string" && isCanonicalSectorL1(x),
    );
    if (filtered.length === 0) delete out.sectors_l1;
    else out.sectors_l1 = { ...out.sectors_l1, value: filtered };
  }

  if (out.partners && Array.isArray(out.partners.value)) {
    const cleaned = (out.partners.value as unknown[])
      .map((p) => {
        if (typeof p !== "object" || p === null) return null;
        const obj = p as { name?: unknown; title?: unknown };
        if (typeof obj.name !== "string" || obj.name.trim().length === 0) return null;
        const title =
          typeof obj.title === "string" && obj.title.trim().length > 0
            ? obj.title.trim()
            : null;
        return { name: obj.name.trim(), title };
      })
      .filter((p): p is { name: string; title: string | null } => p !== null);
    if (cleaned.length === 0) delete out.partners;
    else out.partners = { ...out.partners, value: cleaned };
  }

  if (out.portfolio_companies && Array.isArray(out.portfolio_companies.value)) {
    const seen = new Set<string>();
    const cleaned = (out.portfolio_companies.value as unknown[])
      .map((c) => {
        if (typeof c !== "object" || c === null) return null;
        const obj = c as { name?: unknown; url?: unknown; fund?: unknown };
        if (typeof obj.name !== "string" || obj.name.trim().length === 0) return null;
        const url =
          typeof obj.url === "string" && /^https?:\/\//i.test(obj.url.trim())
            ? obj.url.trim()
            : null;
        const fund =
          typeof obj.fund === "string" && obj.fund.trim().length > 0
            ? obj.fund.trim()
            : null;
        return { name: obj.name.trim(), url, fund };
      })
      .filter(
        (c): c is { name: string; url: string | null; fund: string | null } =>
          c !== null,
      )
      .filter((c) => {
        const key = `${c.name.toLowerCase()}|${c.fund ?? ""}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    if (cleaned.length === 0) delete out.portfolio_companies;
    else out.portfolio_companies = { ...out.portfolio_companies, value: cleaned };
  }

  return out;
}

// Extract structured fields from a tool's raw output. Re-prompts once on
// schema failure. Returns a delta — possibly empty.
export async function extract(input: ExtractorInput): Promise<ExtractedDelta> {
  const client = buildClient();

  const tryOnce = async (
    reminder: string | null,
  ): Promise<{ ok: ExtractedDelta; raw: string } | { error: string; raw: string }> => {
    const raw = await callExtractor(client, input, reminder);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { error: `invalid JSON: ${raw.slice(0, 300)}`, raw };
    }
    const coerced = coerceExtractedDelta(parsed);
    const check = ExtractedDelta.safeParse(coerced);
    if (!check.success) {
      return {
        error: `schema mismatch: ${check.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ").slice(0, 400)}`,
        raw,
      };
    }
    return { ok: stripNonCanonical(check.data), raw };
  };

  const first = await tryOnce(null);
  if ("ok" in first) {
    if (Object.keys(first.ok).length === 0) {
      console.warn("[extract] empty delta on first try. model_raw:", first.raw.slice(0, 800));
    }
    return first.ok;
  }
  console.warn("[extract] first-try failure:", first.error, "\nmodel_raw:", first.raw.slice(0, 800));

  const second = await tryOnce(
    `Previous response failed validation: ${first.error}. Respond with ONLY valid JSON matching the schema.`,
  );
  if ("ok" in second) {
    if (Object.keys(second.ok).length === 0) {
      console.warn("[extract] empty delta on retry. model_raw:", second.raw.slice(0, 800));
    }
    return second.ok;
  }
  console.error("[extract] both tries failed:", second.error, "\nmodel_raw:", second.raw.slice(0, 800));
  return {};
}
