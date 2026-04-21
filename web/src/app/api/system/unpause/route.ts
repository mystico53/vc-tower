import { NextResponse } from "next/server";
import { getAdminAuth, getAdminDb } from "@/lib/firebase/admin";
import { DEFAULT_PROJECT_ID } from "@/lib/firestore/schema";
import { unpauseSystem } from "@/lib/firestore/system-pause";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

// Clears the global pause doc so /api/step resumes serving. v1 is any
// authenticated user — same trust level as the Play button itself. Tighten
// to project-owner when membership lands.
export async function POST(req: Request) {
  const authed = await verifyBearer(req);
  if (!authed) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    await unpauseSystem(getAdminDb(), DEFAULT_PROJECT_ID);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      { error: `unpause failed: ${(e as Error).message}` },
      { status: 500 },
    );
  }
}
