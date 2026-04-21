#!/usr/bin/env node
// Dump a row's full state + every step doc to a local JSON file so we can
// inspect a run (triggered from the UI, a batch, or anywhere else) without
// cracking open the Firestore console. Writes to .harness/dumps/ so all run
// artifacts live under one tree.
//
// Usage:
//   node --env-file=.env.local scripts/dump-row.mjs --rowId 1940
//   node --env-file=.env.local scripts/dump-row.mjs --recent 5       # 5 most recently enriched
//   node --env-file=.env.local scripts/dump-row.mjs --running        # all rows with a running step right now
//   node --env-file=.env.local scripts/dump-row.mjs --rowId 1940 --no-raw   # strip tool_raw_output
//
// Output:
//   .harness/dumps/{iso}_{rowId}.json
//
// Env vars: same as harness-batch.mjs (FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL
// + FIREBASE_PRIVATE_KEY, or GOOGLE_APPLICATION_CREDENTIALS).

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initializeApp, cert, applicationDefault, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_PROJECT_ID = "default";

function parseArgs(argv) {
  const out = {
    rowId: null,
    recent: null,
    running: false,
    noRaw: false,
    projectId: DEFAULT_PROJECT_ID,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--rowId") out.rowId = argv[++i];
    else if (a === "--recent") out.recent = Number.parseInt(argv[++i], 10);
    else if (a === "--running") out.running = true;
    else if (a === "--no-raw") out.noRaw = true;
    else if (a === "--project-id") out.projectId = argv[++i];
    else if (a === "--help" || a === "-h") {
      console.log(
        "node --env-file=.env.local scripts/dump-row.mjs (--rowId ID | --recent N | --running) [--no-raw] [--project-id default]",
      );
      process.exit(0);
    }
  }
  const modes = [out.rowId != null, out.recent != null, out.running].filter(Boolean).length;
  if (modes !== 1) {
    throw new Error("Exactly one of --rowId, --recent <N>, or --running is required.");
  }
  if (out.recent != null && (!Number.isFinite(out.recent) || out.recent <= 0)) {
    throw new Error(`--recent must be a positive integer, got ${out.recent}`);
  }
  return out;
}

function initFirebase() {
  if (getApps().length > 0) return;
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (projectId && clientEmail && privateKey) {
    initializeApp({ credential: cert({ projectId, clientEmail, privateKey }), projectId });
    return;
  }
  const fallbackProjectId = projectId ?? process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GCLOUD_PROJECT;
  try {
    initializeApp(fallbackProjectId
      ? { credential: applicationDefault(), projectId: fallbackProjectId }
      : { credential: applicationDefault() });
  } catch (e) {
    throw new Error(
      `firebase-admin init failed: ${e.message}. ` +
      `Either set FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY in .env.local, ` +
      `or point GOOGLE_APPLICATION_CREDENTIALS at a service-account JSON file.`,
    );
  }
}

async function resolveRowIds(db, args) {
  if (args.rowId) return [args.rowId];

  if (args.recent != null) {
    // Rows sorted by last_enriched_at desc. Uses the implicit single-field
    // index on last_enriched_at.
    const snap = await db
      .collection(`projects/${args.projectId}/rows`)
      .orderBy("last_enriched_at", "desc")
      .limit(args.recent)
      .get();
    return snap.docs.map((d) => d.id);
  }

  // --running: all rows that currently have at least one step with
  // status=running. Uses the same collectionGroup index useLiveSteps relies on.
  const snap = await db
    .collectionGroup("steps")
    .where("project_id", "==", args.projectId)
    .where("status", "==", "running")
    .get();
  const ids = new Set();
  for (const doc of snap.docs) {
    const d = doc.data();
    if (typeof d.row_id === "string") ids.add(d.row_id);
  }
  return [...ids];
}

async function dumpRow(db, projectId, rowId, { noRaw }) {
  const rowRef = db.doc(`projects/${projectId}/rows/${rowId}`);
  const rowSnap = await rowRef.get();
  if (!rowSnap.exists) {
    return { rowId, error: "row not found" };
  }
  const stepsSnap = await db
    .collection(`projects/${projectId}/rows/${rowId}/steps`)
    .orderBy("idx", "asc")
    .get();
  const steps = stepsSnap.docs.map((d) => {
    const data = d.data();
    if (noRaw) {
      const { tool_raw_output: _omit, ...rest } = data;
      return rest;
    }
    return data;
  });
  return {
    rowId,
    dump: {
      dumped_at: new Date().toISOString(),
      project_id: projectId,
      row: rowSnap.data(),
      steps,
    },
  };
}

function fmtBytes(n) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  initFirebase();
  const db = getFirestore();

  const rowIds = await resolveRowIds(db, args);
  if (rowIds.length === 0) {
    console.log("No rows matched.");
    return;
  }

  const iso = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = path.join(WEB_ROOT, ".harness", "dumps");
  await fs.mkdir(outDir, { recursive: true });

  console.log(`Dumping ${rowIds.length} row${rowIds.length === 1 ? "" : "s"} to ${outDir}`);
  console.log("");

  let ok = 0;
  let failed = 0;
  for (const rowId of rowIds) {
    const result = await dumpRow(db, args.projectId, rowId, { noRaw: args.noRaw });
    if (result.error) {
      console.log(`  ${rowId}: ${result.error}`);
      failed += 1;
      continue;
    }
    const file = path.join(outDir, `${iso}_${rowId}.json`);
    const body = JSON.stringify(result.dump, null, 2);
    await fs.writeFile(file, body);
    const stepCount = result.dump.steps.length;
    console.log(`  ${rowId}: ${stepCount} step${stepCount === 1 ? "" : "s"} · ${fmtBytes(Buffer.byteLength(body))} · ${path.relative(WEB_ROOT, file)}`);
    ok += 1;
  }

  console.log("");
  console.log(`Wrote ${ok}/${rowIds.length}${failed > 0 ? ` (${failed} failed)` : ""}.`);
}

main().catch((e) => {
  console.error(e.stack || e.message || e);
  process.exit(1);
});
