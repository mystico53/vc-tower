import { NextResponse } from "next/server";
import Database from "better-sqlite3";
import { getAdminDb } from "@/lib/firebase/admin";
import { DEFAULT_PROJECT_ID, paths } from "@/lib/firestore/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type SqliteRow = {
  id: number;
  source: string;
  source_row: number | null;
  investor_type: string | null;
  kind_raw: string | null;
  name: string | null;
  person_first: string | null;
  person_last: string | null;
  firm_name: string | null;
  email: string | null;
  linkedin: string | null;
  website: string | null;
  twitter: string | null;
  hq_address: string | null;
  hq_country: string | null;
  countries_invest_json: string | null;
  sectors_l1_json: string | null;
  sectors_l2_json: string | null;
  sectors_raw: string | null;
  stages_json: string | null;
  stages_openvc_json: string | null;
  stages_raw: string | null;
  check_min_usd: number | null;
  check_max_usd: number | null;
  check_bands_json: string | null;
  check_raw: string | null;
  num_investments_band: string | null;
  thesis: string | null;
  notes: string | null;
  linked_firm_id: number | null;
  completeness_score: number | null;
  missing_fields_json: string | null;
  quality_flags_json: string | null;
};

function parseJsonArray(s: string | null): string[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

function rowDoc(r: SqliteRow) {
  return {
    source: r.source,
    source_row: r.source_row,
    investor_type: r.investor_type ?? "unknown",
    kind_raw: r.kind_raw,
    name: r.name,
    person_first: r.person_first,
    person_last: r.person_last,
    firm_name: r.firm_name,
    email: r.email,
    linkedin: r.linkedin,
    website: r.website,
    twitter: r.twitter,
    hq_address: r.hq_address,
    hq_country: r.hq_country,
    countries_invest: parseJsonArray(r.countries_invest_json),
    sectors_l1: parseJsonArray(r.sectors_l1_json),
    sectors_l2: parseJsonArray(r.sectors_l2_json),
    sectors_raw: r.sectors_raw,
    stages: parseJsonArray(r.stages_json),
    stages_openvc: parseJsonArray(r.stages_openvc_json),
    stages_raw: r.stages_raw,
    check_min_usd: r.check_min_usd,
    check_max_usd: r.check_max_usd,
    check_bands: parseJsonArray(r.check_bands_json),
    check_raw: r.check_raw,
    num_investments_band: r.num_investments_band,
    thesis: r.thesis,
    notes: r.notes,
    linked_firm_id: r.linked_firm_id,
    completeness_score: r.completeness_score ?? 0,
    missing_fields: parseJsonArray(r.missing_fields_json),
    quality_flags: parseJsonArray(r.quality_flags_json),
    last_enriched_at: null,
    total_steps: 0,
    tool_budget_cents_used: 0,
  };
}

export async function POST(req: Request) {
  const provided = req.headers.get("x-ingest-token");
  const expected = process.env.INGEST_TOKEN;
  if (!expected || provided !== expected) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const dbPath = process.env.MASTERLIST_DB_PATH;
  if (!dbPath) {
    return NextResponse.json(
      { error: "MASTERLIST_DB_PATH not set" },
      { status: 500 },
    );
  }

  let sqlite: Database.Database;
  try {
    sqlite = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch (e) {
    return NextResponse.json(
      { error: `Failed to open masterlist: ${(e as Error).message}` },
      { status: 500 },
    );
  }

  const rows = sqlite
    .prepare(
      `SELECT id, source, source_row, investor_type, kind_raw, name,
              person_first, person_last, firm_name,
              email, linkedin, website, twitter,
              hq_address, hq_country, countries_invest_json,
              sectors_l1_json, sectors_l2_json, sectors_raw,
              stages_json, stages_openvc_json, stages_raw,
              check_min_usd, check_max_usd, check_bands_json, check_raw,
              num_investments_band, thesis, notes,
              linked_firm_id, completeness_score,
              missing_fields_json, quality_flags_json
         FROM investors`,
    )
    .all() as SqliteRow[];
  sqlite.close();

  const adminDb = getAdminDb();
  const projectRef = adminDb.doc(paths.project(DEFAULT_PROJECT_ID));
  await projectRef.set(
    {
      id: DEFAULT_PROJECT_ID,
      name: "Main",
      created_at: new Date().toISOString(),
      row_count: rows.length,
    },
    { merge: true },
  );

  // Firestore commits cap at 500 writes per batch.
  const BATCH = 450;
  let written = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = adminDb.batch();
    for (const r of rows.slice(i, i + BATCH)) {
      const ref = projectRef.collection("rows").doc(String(r.id));
      batch.set(ref, rowDoc(r), { merge: true });
    }
    await batch.commit();
    written += Math.min(BATCH, rows.length - i);
  }

  return NextResponse.json({ ok: true, written, total: rows.length });
}

export async function GET() {
  return NextResponse.json({
    hint: "POST with header 'x-ingest-token: $INGEST_TOKEN' to trigger ingest.",
  });
}
