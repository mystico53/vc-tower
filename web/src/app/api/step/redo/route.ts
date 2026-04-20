import { NextResponse } from "next/server";
import { getAdminAuth, getAdminDb } from "@/lib/firebase/admin";
import { DEFAULT_PROJECT_ID, paths, type Step } from "@/lib/firestore/schema";

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

// Truncate the step log at idx=`fromIdx`: deletes step `fromIdx` and all later
// steps, refunds their tool_cost_cents to the row's budget, and rolls
// total_steps back to `fromIdx`. Does NOT un-merge field values — deleted
// steps' extractions remain on the row. User clicks Step afterward to re-run
// from this point.
export async function POST(req: Request) {
  if (!(await verifyBearer(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const rowId = url.searchParams.get("rowId");
  const fromIdxRaw = url.searchParams.get("fromIdx");
  if (!rowId) {
    return NextResponse.json({ error: "rowId required" }, { status: 400 });
  }
  const fromIdx = Number(fromIdxRaw);
  if (!Number.isInteger(fromIdx) || fromIdx < 0) {
    return NextResponse.json({ error: "fromIdx must be a non-negative integer" }, { status: 400 });
  }

  const projectId = DEFAULT_PROJECT_ID;
  const db = getAdminDb();
  const rowRef = db.doc(paths.row(projectId, rowId));
  const rowSnap = await rowRef.get();
  if (!rowSnap.exists) {
    return NextResponse.json({ error: "row not found" }, { status: 404 });
  }

  const stepsCol = rowRef.collection("steps");
  const toDeleteSnap = await stepsCol.where("idx", ">=", fromIdx).get();
  if (toDeleteSnap.empty) {
    return NextResponse.json({ ok: true, deleted: 0, refunded_cents: 0 });
  }

  let refundedCents = 0;
  for (const d of toDeleteSnap.docs) {
    const s = d.data() as Step;
    refundedCents += Number(s.tool_cost_cents ?? 0);
  }

  // Batch-delete in pages of 450 (matches /api/ingest + reset conventions).
  const docs = toDeleteSnap.docs;
  for (let i = 0; i < docs.length; i += 450) {
    const batch = db.batch();
    docs.slice(i, i + 450).forEach((d) => batch.delete(d.ref));
    await batch.commit();
  }

  const rowData = rowSnap.data() as { tool_budget_cents_used?: number };
  const budgetUsed = Math.max(0, (rowData.tool_budget_cents_used ?? 0) - refundedCents);
  await rowRef.update({
    total_steps: fromIdx,
    tool_budget_cents_used: budgetUsed,
  });

  return NextResponse.json({
    ok: true,
    deleted: toDeleteSnap.size,
    refunded_cents: refundedCents,
    total_steps: fromIdx,
    tool_budget_cents_used: budgetUsed,
  });
}
