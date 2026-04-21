#!/usr/bin/env node
// Sweep for stuck "running" step docs and flip them to "error".
//
// Why this exists: the orchestrator's self-heal only runs *lazily* — when
// runOneStep is next called on that row. If the write path for a step crashed
// (e.g. the Firestore "undefined timings" bug), the step doc stays
// status=running with finished_at=null forever, which bleeds into the dashboard
// and the "running" pulse on the grid. This script does the same self-heal
// across every affected row in one pass.
//
// Usage:
//   node --env-file=.env.local scripts/unstick-running.mjs          # prompts y/N
//   node --env-file=.env.local scripts/unstick-running.mjs --yes    # no prompt
//   node --env-file=.env.local scripts/unstick-running.mjs --dry-run
//   node --env-file=.env.local scripts/unstick-running.mjs --minutes 10   # age threshold (default 3)
//
// Env vars: same as scripts/harness-batch.mjs (FIREBASE_PROJECT_ID +
// FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY, or GOOGLE_APPLICATION_CREDENTIALS).

import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { initializeApp, cert, applicationDefault, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const DEFAULT_PROJECT_ID = "default";

function parseArgs(argv) {
  const out = { yes: false, dryRun: false, minutes: 3, projectId: DEFAULT_PROJECT_ID };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--yes" || a === "-y") out.yes = true;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--minutes") out.minutes = Number.parseInt(argv[++i], 10);
    else if (a === "--project-id") out.projectId = argv[++i];
    else if (a === "--help" || a === "-h") {
      console.log(
        "node --env-file=.env.local scripts/unstick-running.mjs [--yes] [--dry-run] [--minutes 3] [--project-id default]",
      );
      process.exit(0);
    }
  }
  if (!Number.isFinite(out.minutes) || out.minutes < 0) {
    throw new Error(`--minutes must be >= 0, got ${out.minutes}`);
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

function fmtAge(ms) {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  initFirebase();
  const db = getFirestore();

  const thresholdMs = args.minutes * 60_000;
  const nowMs = Date.now();
  const cutoffIso = new Date(nowMs - thresholdMs).toISOString();

  // Use the existing `project_id ASC + started_at DESC` collectionGroup index
  // (the one useLiveSteps relies on). Filtering by `status == "running"`
  // directly would need a different index that isn't provisioned. We bound
  // the scan with `started_at < cutoffIso` so only steps old enough to be
  // stale come back, then client-filter for status=="running".
  const snap = await db
    .collectionGroup("steps")
    .where("project_id", "==", args.projectId)
    .where("started_at", "<", cutoffIso)
    .orderBy("started_at", "desc")
    .get();

  const stuck = [];
  for (const doc of snap.docs) {
    const d = doc.data();
    if (d.status !== "running") continue;
    const startedAt = typeof d.started_at === "string" ? Date.parse(d.started_at) : NaN;
    if (!Number.isFinite(startedAt)) continue;
    const ageMs = nowMs - startedAt;
    stuck.push({
      ref: doc.ref,
      rowId: d.row_id,
      stepId: d.id,
      idx: d.idx,
      chosenTool: d.chosen_tool,
      startedAt: d.started_at,
      ageMs,
    });
  }

  if (stuck.length === 0) {
    console.log(`No stuck running steps older than ${args.minutes}m in project "${args.projectId}".`);
    return;
  }

  stuck.sort((a, b) => b.ageMs - a.ageMs);

  console.log(`Found ${stuck.length} stuck running step${stuck.length === 1 ? "" : "s"} older than ${args.minutes}m:`);
  console.log("");
  console.log("age     rowId                 idx step tool");
  console.log("-----------------------------------------------------------------");
  for (const s of stuck) {
    console.log(
      `${fmtAge(s.ageMs).padEnd(7)} ${String(s.rowId).padEnd(20)} ${String(s.idx).padEnd(3)} ${String(s.stepId).padEnd(4)} ${s.chosenTool ?? "(stop)"}`,
    );
  }
  console.log("");

  if (args.dryRun) {
    console.log("Dry run — no writes.");
    return;
  }

  if (!args.yes) {
    const rl = readline.createInterface({ input, output });
    const answer = await rl.question(`Flip all ${stuck.length} to status=error? [y/N] `);
    rl.close();
    if (!/^y(es)?$/i.test(answer.trim())) {
      console.log("Aborted.");
      return;
    }
  }

  // Sequential patches — don't want to hammer Firestore with 40+ parallel
  // writes, and the self-heal message deserves to be clearly attributed. If
  // any single patch fails, keep going and report the failure at the end.
  const failures = [];
  let ok = 0;
  for (const s of stuck) {
    try {
      await s.ref.update({
        status: "error",
        finished_at: new Date().toISOString(),
        error_message: `swept: stale running step (age ${fmtAge(s.ageMs)})`,
        error_kind: "stale_running",
      });
      ok += 1;
    } catch (e) {
      failures.push({ rowId: s.rowId, stepId: s.stepId, error: e.message });
    }
  }

  console.log(`Swept ${ok}/${stuck.length} stuck steps.`);
  if (failures.length > 0) {
    console.log(`Failures (${failures.length}):`);
    for (const f of failures) {
      console.log(`  row=${f.rowId} step=${f.stepId} — ${f.error}`);
    }
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
