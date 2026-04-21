import { NextResponse } from "next/server";
import { getAdminAuth, getAdminDb } from "@/lib/firebase/admin";
import { DEFAULT_PROJECT_ID, paths, type Row } from "@/lib/firestore/schema";
import { computeCompletenessScore, computeMissingFields } from "@/lib/firestore/missing-fields";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function verifyBearer(req: Request): Promise<boolean> {
  const header = req.headers.get("authorization") || req.headers.get("Authorization");
  if (!header?.startsWith("Bearer ")) return false;
  const token = header.slice("Bearer ".length).trim();
  if (!token) return false;
  try {
    await getAdminAuth().verifyIdToken(token);
    return true;
  } catch {
    return false;
  }
}

// Dev-only: wipe steps subcollection for a row, reset the audit counters,
// AND null out fields the orchestrator typically enriches so the next Step
// click re-runs the full research cycle. Identity, contact, and *_raw seed
// fields are preserved.
export async function POST(req: Request) {
  if (!(await verifyBearer(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const rowId = url.searchParams.get("rowId");
  if (!rowId) {
    return NextResponse.json({ error: "rowId required" }, { status: 400 });
  }

  const projectId = DEFAULT_PROJECT_ID;
  const db = getAdminDb();
  const rowRef = db.doc(paths.row(projectId, rowId));
  const rowSnap = await rowRef.get();
  if (!rowSnap.exists) {
    return NextResponse.json({ error: "row not found" }, { status: 404 });
  }

  // Delete step docs in pages of 450 (same batch cap as /api/ingest).
  const stepsCol = rowRef.collection("steps");
  while (true) {
    const snap = await stepsCol.limit(450).get();
    if (snap.empty) break;
    const batch = db.batch();
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
    if (snap.size < 450) break;
  }

  // Null out fields the orchestrator extracts, then recompute missing_fields
  // against that cleared state so the pills reflect a fresh research cycle.
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
    completeness_score: 0,
    partners: [],
    portfolio_companies: [],
    x_voice_summary: null,
    x_recent_posts: [],
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

  return NextResponse.json({ ok: true });
}
