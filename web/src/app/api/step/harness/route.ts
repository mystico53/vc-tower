import { NextResponse } from "next/server";
import type { DocumentSnapshot, Firestore } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { verifyDevHarnessAuth } from "@/lib/firebase/dev-auth";
import { env } from "@/lib/env";
import { DEFAULT_PROJECT_ID, InvestorType, paths, type Row } from "@/lib/firestore/schema";
import { computeCompletenessScore, computeMissingFields } from "@/lib/firestore/missing-fields";
import { BudgetExceededError } from "@/lib/firestore/step-writer";
import { PreCheckError, runOneStep, type StepOutcome } from "@/lib/orchestrator/step-runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// ---- types ------------------------------------------------------------

type HarnessFilter = {
  investor_type?: string;
  country?: string;
  minScore?: number;
  maxScore?: number;
  has_website?: boolean;
  has_linkedin?: boolean;
};

type HarnessBody = {
  rowId?: string;
  filter?: HarnessFilter;
  random?: boolean;
  steps?: number;
  reset?: boolean;
};

type ExtractedReport = {
  field: string;
  confidence: number | null;
  has_evidence: boolean;
  decision: "merged" | "blocked";
  blocked_by: string | null;
  value_preview: unknown;
};

type StepReport = {
  idx: number;
  stepId: string;
  status: StepOutcome["status"];
  decision: StepOutcome["decision"];
  tool_cost_cents: number;
  tool_error: string | null;
  extracted: ExtractedReport[];
  merged_fields: string[];
  row_diff: Record<string, { before: unknown; after: unknown }>;
};

// ---- helpers ----------------------------------------------------------

function preview(v: unknown, max = 160): unknown {
  if (typeof v !== "string") return v;
  if (v.length <= max) return v;
  return `${v.slice(0, max)}…`;
}

function parseBody(raw: unknown): HarnessBody | { error: string } {
  if (!raw || typeof raw !== "object") return { error: "body must be an object" };
  const b = raw as Record<string, unknown>;
  const out: HarnessBody = {};
  if (typeof b.rowId === "string") out.rowId = b.rowId;
  if (b.filter && typeof b.filter === "object") {
    const f = b.filter as Record<string, unknown>;
    out.filter = {};
    if (typeof f.investor_type === "string") out.filter.investor_type = f.investor_type;
    if (typeof f.country === "string") out.filter.country = f.country;
    if (typeof f.minScore === "number") out.filter.minScore = f.minScore;
    if (typeof f.maxScore === "number") out.filter.maxScore = f.maxScore;
    if (typeof f.has_website === "boolean") out.filter.has_website = f.has_website;
    if (typeof f.has_linkedin === "boolean") out.filter.has_linkedin = f.has_linkedin;
  }
  if (typeof b.random === "boolean") out.random = b.random;
  if (typeof b.steps === "number") out.steps = b.steps;
  if (typeof b.reset === "boolean") out.reset = b.reset;
  if (!out.rowId && !out.filter) {
    return { error: "one of `rowId` or `filter` must be provided" };
  }
  if (out.filter?.investor_type) {
    const parsed = InvestorType.safeParse(out.filter.investor_type);
    if (!parsed.success) {
      return { error: `invalid investor_type: ${out.filter.investor_type}` };
    }
  }
  return out;
}

async function pickRow(
  db: Firestore,
  projectId: string,
  filter: HarnessFilter,
  random: boolean,
): Promise<{ rowId: string; candidates: number } | null> {
  let q: FirebaseFirestore.Query = db.collection(paths.rows(projectId));
  if (filter.investor_type) q = q.where("investor_type", "==", filter.investor_type);
  else if (filter.country) q = q.where("hq_country", "==", filter.country);
  if (typeof filter.minScore === "number") q = q.where("completeness_score", ">=", filter.minScore);
  if (typeof filter.maxScore === "number") q = q.where("completeness_score", "<", filter.maxScore);
  q = q.orderBy("completeness_score", "asc").limit(200);

  const snap = await q.get();
  const postFiltered = snap.docs.filter((d: DocumentSnapshot) => {
    const data = d.data();
    if (!data) return false;
    if (filter.has_website !== undefined) {
      const has = typeof data.website === "string" && data.website.length > 0;
      if (has !== filter.has_website) return false;
    }
    if (filter.has_linkedin !== undefined) {
      const has = typeof data.linkedin === "string" && data.linkedin.length > 0;
      if (has !== filter.has_linkedin) return false;
    }
    return true;
  });

  if (postFiltered.length === 0) return null;
  const pick = random
    ? postFiltered[Math.floor(Math.random() * postFiltered.length)]
    : postFiltered[0];
  return { rowId: pick.id, candidates: postFiltered.length };
}

async function resetRow(db: Firestore, projectId: string, rowId: string): Promise<void> {
  const rowRef = db.doc(paths.row(projectId, rowId));
  const rowSnap = await rowRef.get();
  if (!rowSnap.exists) throw new PreCheckError("row_not_found");

  const stepsCol = rowRef.collection("steps");
  while (true) {
    const snap = await stepsCol.limit(450).get();
    if (snap.empty) break;
    const batch = db.batch();
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
    if (snap.size < 450) break;
  }

  const cleared: Partial<Row> = {
    stages: [],
    sectors_l1: [],
    sectors_l2: [],
    thesis: null,
    check_min_usd: null,
    check_max_usd: null,
    check_bands: [],
    hq_country: null,
    hq_address: null,
    countries_invest: [],
    num_investments_band: null,
    completeness_score: 0,
    partners: [],
    portfolio_companies: [],
    scrape_status: null,
    scrape_status_reason: null,
  };
  const row = rowSnap.data() as Row;
  const merged = { ...row, ...cleared };
  const recomputed = computeMissingFields(merged);
  await rowRef.update({
    ...cleared,
    total_steps: 0,
    tool_budget_cents_used: 0,
    last_enriched_at: null,
    missing_fields: recomputed,
    completeness_score: computeCompletenessScore(recomputed),
  });
}

function buildExtractedReports(outcome: StepOutcome): ExtractedReport[] {
  const mergedSet = new Set(outcome.merged_fields);
  const out: ExtractedReport[] = [];
  for (const [field, delta] of Object.entries(outcome.extracted)) {
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

// Fields whose diff is worth surfacing per step — orchestrator-writable and
// likely to change as a result of a merge.
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
  "total_steps",
  "tool_budget_cents_used",
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

function previewIfLong(v: unknown): unknown {
  if (typeof v === "string") return preview(v);
  if (Array.isArray(v) && v.length > 20) {
    return [...v.slice(0, 20), `… (${v.length - 20} more)`];
  }
  return v;
}

function summarizeInitialRow(row: Row) {
  return {
    id: row.id,
    name: row.name,
    investor_type: row.investor_type,
    website: row.website,
    linkedin: row.linkedin,
    twitter: row.twitter,
    email: row.email,
    completeness_score: row.completeness_score,
    missing_fields: row.missing_fields,
    total_steps: row.total_steps,
    tool_budget_cents_used: row.tool_budget_cents_used,
    scrape_status: row.scrape_status ?? null,
    scrape_status_reason: row.scrape_status_reason ?? null,
  };
}

// ---- route ------------------------------------------------------------

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

  const db = getAdminDb();
  const projectId = DEFAULT_PROJECT_ID;

  // 1. Resolve rowId — explicit or via filter.
  let rowId: string;
  let pickedBy: "rowId" | "filter";
  let candidatesCount: number | null = null;
  if (body.rowId) {
    rowId = body.rowId;
    pickedBy = "rowId";
  } else {
    const picked = await pickRow(db, projectId, body.filter!, body.random ?? false);
    if (!picked) {
      return NextResponse.json({ error: "no rows match filter" }, { status: 404 });
    }
    rowId = picked.rowId;
    candidatesCount = picked.candidates;
    pickedBy = "filter";
  }

  // 2. Optional reset.
  if (body.reset) {
    try {
      await resetRow(db, projectId, rowId);
    } catch (e) {
      if (e instanceof PreCheckError && e.code === "row_not_found") {
        return NextResponse.json({ error: "row not found" }, { status: 404 });
      }
      return NextResponse.json({ error: `reset failed: ${(e as Error).message}` }, { status: 500 });
    }
  }

  // 3. Snapshot initial row state.
  const initialSnap = await db.doc(paths.row(projectId, rowId)).get();
  if (!initialSnap.exists) {
    return NextResponse.json({ error: "row not found" }, { status: 404 });
  }
  const initialRow = initialSnap.data() as Row;
  const initialRowSummary = summarizeInitialRow({ ...initialRow, id: initialSnap.id });

  // 4. Step loop.
  const desiredSteps = Math.max(1, Math.min(body.steps ?? 5, env.STEP_MAX_PER_ROW));
  const stepReports: StepReport[] = [];
  let finalRow: Row = initialRow;

  for (let i = 0; i < desiredSteps; i++) {
    let outcome: StepOutcome;
    try {
      outcome = await runOneStep(db, projectId, rowId);
    } catch (e) {
      if (e instanceof PreCheckError) {
        // Budget / step cap / system paused — stop the loop rather than
        // erroring the whole harness response.
        break;
      }
      if (e instanceof BudgetExceededError) {
        break;
      }
      return NextResponse.json(
        { error: `harness step failed: ${(e as Error).message}`, completed_steps: stepReports.length },
        { status: 500 },
      );
    }

    stepReports.push({
      idx: outcome.idx,
      stepId: outcome.stepId,
      status: outcome.status,
      decision: outcome.decision,
      tool_cost_cents: outcome.tool_cost_cents,
      tool_error: outcome.tool_error,
      extracted: buildExtractedReports(outcome),
      merged_fields: outcome.merged_fields,
      row_diff: buildRowDiff(outcome.row_before, outcome.row_after),
    });
    finalRow = outcome.row_after;

    // Stop loop on terminal statuses.
    if (outcome.status === "stopped" || outcome.status === "error") break;
  }

  return NextResponse.json({
    rowId,
    picked_by: pickedBy,
    candidates_count: candidatesCount,
    reset: body.reset === true,
    initial_row: initialRowSummary,
    steps: stepReports,
    final_row: summarizeInitialRow({ ...finalRow, id: rowId }),
  });
}
