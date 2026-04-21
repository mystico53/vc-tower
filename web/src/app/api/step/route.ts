import { NextResponse } from "next/server";
import { getAdminAuth, getAdminDb } from "@/lib/firebase/admin";
import { DEFAULT_PROJECT_ID } from "@/lib/firestore/schema";
import { BudgetExceededError } from "@/lib/firestore/step-writer";
import { PreCheckError, runOneStep } from "@/lib/orchestrator/step-runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function verifyBearer(req: Request): Promise<{ uid: string } | null> {
  const header = req.headers.get("authorization") || req.headers.get("Authorization");
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  if (!token) return null;
  try {
    const decoded = await getAdminAuth().verifyIdToken(token);
    return { uid: decoded.uid };
  } catch {
    return null;
  }
}

export async function POST(req: Request) {
  const authed = await verifyBearer(req);
  if (!authed) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const rowId =
    typeof parsed === "object" && parsed && "rowId" in parsed && typeof (parsed as { rowId: unknown }).rowId === "string"
      ? (parsed as { rowId: string }).rowId
      : null;
  if (!rowId) {
    return NextResponse.json({ error: "rowId required" }, { status: 400 });
  }

  try {
    const outcome = await runOneStep(getAdminDb(), DEFAULT_PROJECT_ID, rowId);

    if (outcome.status === "stopped") {
      return NextResponse.json({
        stepId: outcome.stepId,
        status: "done",
        stop_reason: outcome.decision.stop_reason,
      });
    }

    if (outcome.status === "error") {
      return NextResponse.json({
        stepId: outcome.stepId,
        status: "error",
        error: outcome.tool_error,
      });
    }

    return NextResponse.json({
      stepId: outcome.stepId,
      status: outcome.status,
      merged: outcome.merged_fields,
      skipped_reason: outcome.status === "skipped" ? "budget" : null,
    });
  } catch (e) {
    if (e instanceof PreCheckError) {
      if (e.code === "row_not_found") {
        return NextResponse.json({ error: "row not found" }, { status: 404 });
      }
      if (e.code === "step_cap") {
        return NextResponse.json({ error: "step cap reached", ...(e.detail as object) }, { status: 409 });
      }
      if (e.code === "budget_exhausted") {
        return NextResponse.json({ error: "budget exhausted", ...(e.detail as object) }, { status: 409 });
      }
      if (e.code === "system_paused") {
        // Distinguishable body so the client can halt the whole run, not just
        // retry this row.
        return NextResponse.json(
          { error: "system paused", code: "system_paused", ...(e.detail as object) },
          { status: 409 },
        );
      }
    }
    if (e instanceof BudgetExceededError) {
      return NextResponse.json({ error: e.message }, { status: 409 });
    }
    return NextResponse.json(
      { error: `orchestrator failed: ${(e as Error).message}` },
      { status: 502 },
    );
  }
}
