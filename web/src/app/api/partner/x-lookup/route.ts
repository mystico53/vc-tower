import { NextResponse } from "next/server";
import { getAdminAuth, getAdminDb } from "@/lib/firebase/admin";
import { DEFAULT_PROJECT_ID, paths, type Row } from "@/lib/firestore/schema";
import { grokXLookup, parseGrokProfile } from "@/lib/tools/grok-x-search";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Grok's x_search + reasoning takes longer than the orchestrator's usual
// scrape — give it room to finish before Vercel kills the invocation.
export const maxDuration = 90;

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

type Body = { rowId?: unknown; partnerName?: unknown };

// Manual per-partner X lookup. User clicks the button next to a partner in
// the drawer; we call Grok once, parse its JSON reply directly (skipping the
// Qwen extractor since the shape is already structured), and merge the result
// into that partner's slot inside row.partners. Cost is counted toward the
// row's tool budget so the drawer's Budget badge reflects the spend, but we
// don't create a Step doc — these aren't orchestrator decisions.
export async function POST(req: Request) {
  if (!(await verifyBearer(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let parsed: Body;
  try {
    parsed = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const rowId = typeof parsed.rowId === "string" ? parsed.rowId : "";
  const partnerName = typeof parsed.partnerName === "string" ? parsed.partnerName.trim() : "";
  if (!rowId || !partnerName) {
    return NextResponse.json({ error: "rowId and partnerName required" }, { status: 400 });
  }

  const db = getAdminDb();
  const rowRef = db.doc(paths.row(DEFAULT_PROJECT_ID, rowId));
  const rowSnap = await rowRef.get();
  if (!rowSnap.exists) {
    return NextResponse.json({ error: "row not found" }, { status: 404 });
  }
  const row = rowSnap.data() as Row;
  const partners = row.partners ?? [];
  const idx = partners.findIndex(
    (p) => p.name.trim().toLowerCase() === partnerName.toLowerCase(),
  );
  if (idx < 0) {
    return NextResponse.json({ error: "partner not found on row" }, { status: 404 });
  }

  const firm = row.firm_name ?? row.name ?? undefined;
  const existingHandle = partners[idx].x_handle ?? undefined;
  const result = await grokXLookup({
    name: partnerName,
    firm: firm ?? undefined,
    handle: existingHandle ?? undefined,
  });

  if (!result.ok) {
    return NextResponse.json(
      { error: result.error ?? "grok lookup failed" },
      { status: 502 },
    );
  }

  const profile = parseGrokProfile(result.raw);
  if (!profile || (!profile.voice_summary && profile.recent_posts.length === 0)) {
    return NextResponse.json(
      { error: "grok returned no usable profile data" },
      { status: 502 },
    );
  }

  // Re-read partners inside a transaction before writing. Grok's lookup takes
  // 10-30s; if the orchestrator ran a LinkedIn scrape in that window and
  // updated row.partners (e.g. filled a photo_url), a non-transactional write
  // would clobber the new state with our stale snapshot. Matching by name at
  // write time also self-heals if the partner's index shifted.
  await db.runTransaction(async (tx) => {
    const fresh = await tx.get(rowRef);
    if (!fresh.exists) throw new Error("row deleted mid-request");
    const freshRow = fresh.data() as Row;
    const freshPartners = freshRow.partners ?? [];
    const targetIdx = freshPartners.findIndex(
      (p) => p.name.trim().toLowerCase() === partnerName.toLowerCase(),
    );
    if (targetIdx < 0) throw new Error("partner no longer on row");
    const nextPartners = freshPartners.map((p, i) =>
      i === targetIdx
        ? {
            ...p,
            x_handle: profile.handle ?? p.x_handle ?? null,
            x_voice_summary: profile.voice_summary ?? p.x_voice_summary ?? null,
            x_recent_posts:
              profile.recent_posts.length > 0
                ? profile.recent_posts
                : p.x_recent_posts ?? [],
          }
        : p,
    );
    tx.update(rowRef, {
      partners: nextPartners,
      tool_budget_cents_used:
        (freshRow.tool_budget_cents_used ?? 0) + (result.cost_cents ?? 0),
    });
  });

  return NextResponse.json({
    ok: true,
    handle: profile.handle,
    voice_summary: profile.voice_summary,
    recent_posts_count: profile.recent_posts.length,
    cost_cents: result.cost_cents ?? 0,
  });
}
