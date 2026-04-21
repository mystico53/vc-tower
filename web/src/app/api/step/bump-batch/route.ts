import { NextResponse } from "next/server";
import { getAdminAuth, getAdminDb } from "@/lib/firebase/admin";
import { DEFAULT_PROJECT_ID, paths, type Row } from "@/lib/firestore/schema";
import { computeScrapeStatus } from "@/lib/firestore/missing-fields";
import { bumpBatchAttempt } from "@/lib/firestore/step-writer";
import { env } from "@/lib/env";
import type { Step } from "@/lib/firestore/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Called by the play-scrape client at the end of its inner loop to record
// that one full scrape batch just finished on a row. Body: { rowId,
// merged_this_run }. Auth: Firebase Bearer (same as /api/step). Updates
// batch_attempts / zero_progress_streak / last_batch_attempt_at via
// bumpBatchAttempt, then recomputes scrape_status so the UI shows
// "dead_letter" immediately when the streak crosses DEAD_LETTER_STREAK.

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

export async function POST(req: Request) {
  if (!(await verifyBearer(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: { rowId?: string; merged_this_run?: boolean };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  if (typeof body.rowId !== "string" || body.rowId.length === 0) {
    return NextResponse.json({ error: "rowId required" }, { status: 400 });
  }
  const mergedThisRun = body.merged_this_run === true;

  const db = getAdminDb();
  const projectId = DEFAULT_PROJECT_ID;

  const { batch_attempts, zero_progress_streak } = await bumpBatchAttempt(
    db,
    projectId,
    body.rowId,
    mergedThisRun,
  );

  // Recompute scrape_status against the freshly-bumped streak so
  // "dead_letter" becomes visible right away. We re-read the steps doc
  // history + the row for the same inputs finalizeRow uses.
  const rowRef = db.doc(paths.row(projectId, body.rowId));
  const rowSnap = await rowRef.get();
  const row = rowSnap.data() as Row;
  const stepsSnap = await db
    .collection(paths.steps(projectId, body.rowId))
    .orderBy("idx", "asc")
    .get();
  const classified = stepsSnap.docs.map((d) => {
    const s = d.data() as Step;
    return {
      status: s.status,
      chosen_tool: s.chosen_tool,
      extracted_count: Object.keys((s.extracted_fields as Record<string, unknown>) ?? {}).length,
      error_message: s.error_message,
    };
  });
  const { status, reason } = computeScrapeStatus({
    missing: row.missing_fields ?? [],
    steps: classified,
    total_steps: row.total_steps ?? 0,
    step_cap: env.STEP_MAX_PER_ROW,
    zero_progress_streak,
    dead_letter_streak: env.DEAD_LETTER_STREAK,
  });
  if (status !== (row.scrape_status ?? null) || reason !== (row.scrape_status_reason ?? null)) {
    await rowRef.update({ scrape_status: status, scrape_status_reason: reason });
  }

  return NextResponse.json({
    ok: true,
    batch_attempts,
    zero_progress_streak,
    scrape_status: status,
  });
}
