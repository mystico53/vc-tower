import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { verifyDevHarnessAuth } from "@/lib/firebase/dev-auth";
import { DEFAULT_PROJECT_ID, paths, type Row, type Step } from "@/lib/firestore/schema";
import {
  applyMergeToRow,
  detectRebrandRedirect,
  simulateMerge,
  type MergeOutcome,
} from "@/lib/firestore/step-writer";
import { extract, type ExtractedDelta } from "@/lib/orchestrator/extract";
import { computeCompletenessScore, computeMissingFields } from "@/lib/firestore/missing-fields";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Replay the extract + merge pipeline for a row's already-captured step
// outputs. Zero tool cost — no firecrawl / apify / grok calls. Three modes:
//
//   merge_only         : use each step's stored extracted_fields verbatim and
//                        re-run simulateMerge against a cumulative clean row.
//                        ZERO LLM cost. Use this to iterate on merge-guard
//                        changes (confidence floors, immutable_contact rules,
//                        anti_truncation, partners/portfolio keyed unions).
//   extract_and_merge  : re-run extract() with the stored tool_raw_output,
//                        then simulateMerge. Costs Dashscope (~1¢/step) but
//                        no tool credits. Use this to iterate on extractor
//                        prompts or coercion rules.
//   extract_only       : re-run extract() with the stored tool_raw_output
//                        against the *current* row state, no merge. Returns
//                        raw deltas. Useful for diagnosing hallucinations.
//
// All modes return a per-step report with the same shape as /api/step/harness
// so downstream tooling can diff harness vs replay outputs byte-for-byte.

type ReplayMode = "merge_only" | "extract_only" | "extract_and_merge";

type ReplayBody = {
  rowId: string;
  mode?: ReplayMode;
  step_ids?: string[];
};

type ExtractedReport = {
  field: string;
  confidence: number | null;
  has_evidence: boolean;
  decision: "merged" | "blocked";
  blocked_by: string | null;
  value_preview: unknown;
};

type StepReplayReport = {
  idx: number;
  stepId: string;
  chosen_tool: string | null;
  status: string;
  extracted: ExtractedReport[];
  merged_fields: string[];
  skip_reasons: Record<string, string>;
  row_diff: Record<string, { before: unknown; after: unknown }>;
};

function parseBody(raw: unknown): ReplayBody | { error: string } {
  if (!raw || typeof raw !== "object") return { error: "body must be an object" };
  const b = raw as Record<string, unknown>;
  if (typeof b.rowId !== "string" || b.rowId.length === 0) {
    return { error: "rowId required" };
  }
  const out: ReplayBody = { rowId: b.rowId };
  if (b.mode !== undefined) {
    if (b.mode !== "merge_only" && b.mode !== "extract_only" && b.mode !== "extract_and_merge") {
      return { error: `invalid mode: ${String(b.mode)}` };
    }
    out.mode = b.mode;
  }
  if (Array.isArray(b.step_ids)) {
    const ids = b.step_ids.filter((x): x is string => typeof x === "string");
    if (ids.length > 0) out.step_ids = ids;
  }
  return out;
}

function preview(v: unknown, max = 160): unknown {
  if (typeof v !== "string") return v;
  if (v.length <= max) return v;
  return `${v.slice(0, max)}…`;
}

function previewIfLong(v: unknown): unknown {
  if (typeof v === "string") return preview(v);
  if (Array.isArray(v) && v.length > 20) {
    return [...v.slice(0, 20), `… (${v.length - 20} more)`];
  }
  return v;
}

const DIFF_FIELDS: Array<keyof Row> = [
  "thesis",
  "stages",
  "sectors_l1",
  "sectors_l2",
  "check_min_usd",
  "check_max_usd",
  "hq_country",
  "hq_address",
  "countries_invest",
  "partners",
  "portfolio_companies",
  "email",
  "linkedin",
  "website",
  "twitter",
  "completeness_score",
  "missing_fields",
];

function buildRowDiff(before: Row, after: Row): Record<string, { before: unknown; after: unknown }> {
  const diff: Record<string, { before: unknown; after: unknown }> = {};
  for (const key of DIFF_FIELDS) {
    const a = (before as unknown as Record<string, unknown>)[key];
    const b = (after as unknown as Record<string, unknown>)[key];
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      diff[key] = { before: previewIfLong(a), after: previewIfLong(b) };
    }
  }
  return diff;
}

// The "clean" starting row for cumulative replay. Preserves the seed identity /
// contact data the ingest supplied (row-level truth) and zeroes every
// orchestrator-computed field so each step's contribution is visible in the
// diff. Mirrors resetRow() in /api/step/harness — kept in this one file for
// now to avoid surprise coupling; promote to a shared helper if a third caller
// appears.
function clearedRow(row: Row): Row {
  const cleared: Partial<Row> = {
    stages: [],
    stages_openvc: [],
    stages_raw: null,
    sectors_l1: [],
    sectors_l2: [],
    sectors_raw: null,
    thesis: null,
    notes: null,
    check_min_usd: null,
    check_max_usd: null,
    check_bands: [],
    check_raw: null,
    hq_country: null,
    hq_address: null,
    countries_invest: [],
    num_investments_band: null,
    partners: [],
    portfolio_companies: [],
    x_voice_summary: null,
    x_recent_posts: [],
    scrape_status: null,
    scrape_status_reason: null,
    total_steps: 0,
    tool_budget_cents_used: 0,
    last_enriched_at: null,
    completeness_score: 0,
  };
  const next = { ...row, ...cleared } as Row;
  const recomputed = computeMissingFields(next);
  return {
    ...next,
    missing_fields: recomputed,
    completeness_score: computeCompletenessScore(recomputed),
  };
}

function buildExtractedReport(
  extracted: ExtractedDelta,
  outcome: MergeOutcome,
): ExtractedReport[] {
  const mergedSet = new Set(outcome.merged);
  const out: ExtractedReport[] = [];
  for (const [field, delta] of Object.entries(extracted)) {
    if (!delta) continue;
    const hasEvidence =
      typeof delta.evidence_quote === "string" && delta.evidence_quote.trim().length > 0;
    const isMerged = mergedSet.has(field);
    out.push({
      field,
      confidence: typeof delta.confidence === "number" ? delta.confidence : null,
      has_evidence: hasEvidence,
      decision: isMerged ? "merged" : "blocked",
      blocked_by: isMerged ? null : outcome.skip_reasons[field] ?? "unknown",
      value_preview: preview(delta.value),
    });
  }
  return out;
}

// Pull the markdown out of a firecrawl tool_raw_output blob. Non-firecrawl
// tools store their own JSON shape; extract() falls back to stringifying
// the raw payload when markdown is absent, which is fine here.
function markdownFromRaw(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const data = (raw as { data?: unknown }).data;
  if (!data || typeof data !== "object") return undefined;
  const md = (data as { markdown?: unknown }).markdown;
  return typeof md === "string" ? md : undefined;
}

export async function POST(req: Request) {
  const auth = verifyDevHarnessAuth(req);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const body = parseBody(parsed);
  if ("error" in body) {
    return NextResponse.json({ error: body.error }, { status: 400 });
  }

  const mode: ReplayMode = body.mode ?? "merge_only";
  const db = getAdminDb();
  const projectId = DEFAULT_PROJECT_ID;

  const rowRef = db.doc(paths.row(projectId, body.rowId));
  const rowSnap = await rowRef.get();
  if (!rowSnap.exists) {
    return NextResponse.json({ error: "row not found" }, { status: 404 });
  }
  const liveRow = { ...(rowSnap.data() as Row), id: rowSnap.id };

  const stepsSnap = await db
    .collection(paths.steps(projectId, body.rowId))
    .orderBy("idx", "asc")
    .get();

  const allowedIds = body.step_ids ? new Set(body.step_ids) : null;
  // Only replay steps that actually executed a tool and produced output.
  // Stop steps (chosen_tool=null) and live-error steps (status="error" with
  // no raw output) have nothing to re-extract from.
  const candidates = stepsSnap.docs
    .map((d) => ({ id: d.id, data: d.data() as Step }))
    .filter(({ data }) => data.chosen_tool !== null && data.tool_raw_output !== null)
    .filter(({ id }) => !allowedIds || allowedIds.has(id));

  if (candidates.length === 0) {
    return NextResponse.json({
      rowId: body.rowId,
      mode,
      initial_row: liveRow,
      steps: [],
      final_row: liveRow,
      note: "no replayable steps (need chosen_tool + tool_raw_output)",
    });
  }

  // Cumulative replay starts from a cleared seed state so each step's
  // contribution is isolated. For extract_only we don't accumulate — extract
  // runs against the current live row and we just return the delta.
  let cumulative: Row =
    mode === "extract_only" ? liveRow : clearedRow(liveRow);
  const initial_row: Row = cumulative;

  const stepReports: StepReplayReport[] = [];

  for (const { id, data: step } of candidates) {
    let extracted: ExtractedDelta;
    if (mode === "merge_only") {
      // Trust the stored extraction verbatim. Firestore stored it as a plain
      // object; we cast back to ExtractedDelta — it was produced by the same
      // Zod schema so the shape is already clean.
      extracted = (step.extracted_fields ?? {}) as ExtractedDelta;
    } else {
      try {
        extracted = await extract({
          raw: step.tool_raw_output,
          markdown: markdownFromRaw(step.tool_raw_output),
          missingFields: cumulative.missing_fields ?? [],
          row: cumulative,
        });
      } catch (e) {
        return NextResponse.json(
          {
            error: `extract failed on step ${id}: ${(e as Error).message}`,
            completed_steps: stepReports.length,
          },
          { status: 500 },
        );
      }
    }

    const before = cumulative;
    let outcome: MergeOutcome;
    let after: Row;
    if (mode === "extract_only") {
      // No merge — report extract result only. outcome merged=[] so every
      // field reads as "blocked (extract_only mode)".
      outcome = { patch: {}, merged: [], skip_reasons: {}, confidence: {} };
      for (const field of Object.keys(extracted)) {
        outcome.skip_reasons[field] = "extract_only_mode";
      }
      after = before;
    } else {
      outcome = simulateMerge(before, extracted, {
        rebrand_redirect: detectRebrandRedirect(step.tool_raw_output, before.website),
      });
      after = applyMergeToRow(before, outcome);
      cumulative = after;
    }

    stepReports.push({
      idx: step.idx,
      stepId: id,
      chosen_tool: step.chosen_tool,
      status: step.status,
      extracted: buildExtractedReport(extracted, outcome),
      merged_fields: outcome.merged,
      skip_reasons: outcome.skip_reasons,
      row_diff: buildRowDiff(before, after),
    });
  }

  return NextResponse.json({
    rowId: body.rowId,
    mode,
    candidates_count: candidates.length,
    initial_row,
    steps: stepReports,
    final_row: cumulative,
  });
}
