#!/usr/bin/env node
// Batch-run the /api/step/harness endpoint across N random profiles and
// aggregate the results. Used for pre-fix baselines and post-fix verification:
// run once with --baseline, then again after a round of fixes, and diff the
// histograms to see whether the fix actually moved the needle.
//
// Usage:
//   node --env-file=.env.local scripts/harness-batch.mjs --n 10 --steps 5
//   node --env-file=.env.local scripts/harness-batch.mjs --n 10 --baseline
//
// Env vars required (usually in .env.local):
//   HARNESS_DEV_KEY            — auth for /api/step/harness
//   FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY
//                              — firebase-admin creds to fetch step docs
//   HARNESS_URL                — optional override for the dev server base URL
//                                (default http://localhost:3000)
//
// Output:
//   .harness/{iso}[-baseline]/profile_{idx}_{rowId}.json   — one file per run
//   .harness/{iso}[-baseline]/summary.json                 — aggregated report
//   stdout                                                 — compact table

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initializeApp, cert, applicationDefault, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_PROJECT_ID = "default";

function parseArgs(argv) {
  const out = { n: 10, steps: 5, baseline: false, url: process.env.HARNESS_URL ?? "http://localhost:3000" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--n") out.n = Number.parseInt(argv[++i], 10);
    else if (a === "--steps") out.steps = Number.parseInt(argv[++i], 10);
    else if (a === "--baseline") out.baseline = true;
    else if (a === "--url") out.url = argv[++i];
    else if (a === "--help" || a === "-h") {
      console.log("node --env-file=.env.local scripts/harness-batch.mjs [--n 10] [--steps 5] [--baseline] [--url http://localhost:3000]");
      process.exit(0);
    }
  }
  if (!Number.isFinite(out.n) || out.n <= 0) throw new Error(`--n must be positive, got ${out.n}`);
  if (!Number.isFinite(out.steps) || out.steps <= 0) throw new Error(`--steps must be positive, got ${out.steps}`);
  return out;
}

function initFirebase() {
  if (getApps().length > 0) return;
  // Match the web app's admin.ts resolution order: explicit service-account
  // env vars first, then applicationDefault() so GOOGLE_APPLICATION_CREDENTIALS
  // or gcloud workload identity keeps working for anyone who hasn't pasted
  // the split credentials into .env.local.
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

// Surface the real cause of a Node fetch() failure. "fetch failed" by itself
// tells you nothing — the actual network error (ECONNREFUSED, ECONNRESET,
// UND_ERR_SOCKET, etc.) lives in e.cause. Walk the chain and return the most
// specific message we can find.
function describeFetchError(e) {
  const parts = [e.message];
  let c = e.cause;
  let depth = 0;
  while (c && depth < 4) {
    if (c.code) parts.push(`code=${c.code}`);
    if (c.errno) parts.push(`errno=${c.errno}`);
    if (c.syscall) parts.push(`syscall=${c.syscall}`);
    if (c.message && c.message !== e.message) parts.push(c.message);
    c = c.cause;
    depth += 1;
  }
  return parts.join(" · ");
}

async function callHarness(url, devKey, steps) {
  let res;
  try {
    res = await fetch(`${url}/api/step/harness`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-dev-key": devKey },
      body: JSON.stringify({
        filter: {},
        random: true,
        reset: true,
        steps,
        continue_on_error: true,
      }),
    });
  } catch (e) {
    // Annotate with the underlying cause so the batch output explains *why*
    // the fetch failed (server died, connection reset, etc.) instead of the
    // opaque "fetch failed" Node throws by default.
    const err = new Error(`fetch failed: ${describeFetchError(e)}`);
    err.cause = e;
    throw err;
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`harness ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
  }
  return body;
}

// The harness response omits the per-step decision_reasoning and truncates
// tool_raw_output to size. For batch aggregation we want the reasoning (to
// histogram rule-vs-llm) and a short preview of the raw output (to eyeball
// bad extractions). Fetch the step docs directly from Firestore.
async function enrichWithStepDocs(db, rowId, stepReports) {
  const stepsCol = db.collection(`projects/${DEFAULT_PROJECT_ID}/rows/${rowId}/steps`);
  const snap = await stepsCol.orderBy("idx", "asc").get();
  const byId = new Map();
  for (const doc of snap.docs) byId.set(doc.id, doc.data());
  return stepReports.map((r) => {
    const doc = byId.get(r.stepId);
    if (!doc) return r;
    const rawPreview =
      typeof doc.tool_raw_output === "string"
        ? doc.tool_raw_output.slice(0, 240)
        : JSON.stringify(doc.tool_raw_output ?? null).slice(0, 240);
    return {
      ...r,
      decision_reasoning: doc.decision_reasoning ?? null,
      decision_model: doc.decision_model ?? null,
      chosen_tool_args: doc.chosen_tool_args ?? {},
      error_kind: doc.error_kind ?? null,
      error_detail: doc.error_detail ?? null,
      tool_raw_preview: rawPreview,
    };
  });
}

function bump(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function aggregate(runs) {
  const scrapeStatus = new Map();
  const errorKind = new Map();
  const skipReasons = new Map();
  const ruleVsLlm = { rule: 0, llm: 0, unknown: 0 };
  let totalCostCents = 0;
  let totalSteps = 0;

  for (const run of runs) {
    if (!run.result) continue;
    bump(scrapeStatus, run.result.final_row?.scrape_status ?? "null");
    for (const step of run.result.steps ?? []) {
      totalSteps += 1;
      totalCostCents += step.tool_cost_cents ?? 0;
      if (step.tool_error) bump(errorKind, step.error_kind ?? "unclassified");
      for (const reason of Object.values(step.skip_reasons ?? {})) bump(skipReasons, reason);
      const reasoning = step.decision_reasoning ?? "";
      if (reasoning.startsWith("[rule]")) ruleVsLlm.rule += 1;
      else if (reasoning.startsWith("[llm]")) ruleVsLlm.llm += 1;
      else ruleVsLlm.unknown += 1;
    }
  }

  return {
    runs_count: runs.length,
    steps_total: totalSteps,
    cost_cents_total: totalCostCents,
    cost_cents_avg_per_step: totalSteps > 0 ? Math.round((totalCostCents / totalSteps) * 100) / 100 : 0,
    rule_vs_llm: ruleVsLlm,
    rule_ratio: (ruleVsLlm.rule + ruleVsLlm.llm) > 0
      ? Math.round((ruleVsLlm.rule / (ruleVsLlm.rule + ruleVsLlm.llm)) * 100)
      : 0,
    scrape_status: Object.fromEntries([...scrapeStatus.entries()].sort()),
    error_kind: Object.fromEntries([...errorKind.entries()].sort()),
    merge_skip_reasons: Object.fromEntries([...skipReasons.entries()].sort()),
  };
}

function fmtTable(runs) {
  const rows = runs.map((run, idx) => {
    if (!run.result) return { idx, rowId: "-", status: "ERROR", steps: 0, cost: 0, first_error: run.error ?? "?" };
    const r = run.result;
    const first = r.steps.find((s) => s.tool_error);
    return {
      idx,
      rowId: r.rowId?.slice(0, 20) ?? "?",
      status: r.final_row?.scrape_status ?? "null",
      steps: r.steps.length,
      cost: r.steps.reduce((a, s) => a + (s.tool_cost_cents ?? 0), 0),
      first_error: first ? `${first.error_kind ?? "?"}: ${(first.tool_error ?? "").slice(0, 40)}` : "-",
    };
  });
  const header = "idx  rowId                 status        steps cost¢ first_error";
  const sep = "-".repeat(header.length);
  const body = rows
    .map((r) => `${String(r.idx).padEnd(4)} ${r.rowId.padEnd(20)}  ${String(r.status).padEnd(12)} ${String(r.steps).padStart(5)} ${String(r.cost).padStart(5)} ${r.first_error}`)
    .join("\n");
  return `${header}\n${sep}\n${body}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const devKey = process.env.HARNESS_DEV_KEY;
  if (!devKey) throw new Error("HARNESS_DEV_KEY required in env");

  initFirebase();
  const db = getFirestore();

  const iso = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = path.join(WEB_ROOT, ".harness", args.baseline ? `${iso}-baseline` : iso);
  await fs.mkdir(outDir, { recursive: true });
  console.log(`[batch] writing to ${outDir}`);

  const runs = [];
  // Check system state at the top so a pre-existing pause doesn't eat a
  // bunch of reset side-effects. Also re-check after every run — a zero-step
  // response with reset=true strongly implies the system is paused (we asked
  // for N steps, it ran none).
  const systemStateRef = db.doc(`projects/${DEFAULT_PROJECT_ID}/system/state`);
  async function systemPaused() {
    const snap = await systemStateRef.get();
    const data = snap.exists ? snap.data() : null;
    return data?.paused === true ? data : null;
  }
  const initialPause = await systemPaused();
  if (initialPause) {
    console.error(`[batch] ABORT: system is already paused. reason=${initialPause.paused_reason} tool=${initialPause.paused_tool} kind=${initialPause.paused_kind}`);
    console.error(`[batch] unpause via POST /api/system/unpause before re-running.`);
    process.exit(1);
  }

  for (let i = 0; i < args.n; i++) {
    process.stdout.write(`[batch] run ${i + 1}/${args.n}... `);
    try {
      const result = await callHarness(args.url, devKey, args.steps);
      result.steps = await enrichWithStepDocs(db, result.rowId, result.steps ?? []);
      const file = path.join(outDir, `profile_${String(i).padStart(2, "0")}_${result.rowId}.json`);
      await fs.writeFile(file, JSON.stringify(result, null, 2));
      runs.push({ idx: i, result });
      console.log(`ok (${result.rowId}, ${result.steps.length} steps, status=${result.final_row?.scrape_status ?? "null"})`);

      // If the harness silently returned zero steps on a reset-true call,
      // the most likely cause is that the last run's tool error tripped the
      // global pause. Check and stop — otherwise we reset more rows for no
      // reason and keep polluting the output folder with null-status runs.
      if (result.steps.length === 0) {
        const paused = await systemPaused();
        if (paused) {
          console.error(`[batch] ABORT after run ${i + 1}: system paused. reason=${paused.paused_reason} tool=${paused.paused_tool} kind=${paused.paused_kind}`);
          break;
        }
      }
    } catch (e) {
      runs.push({ idx: i, error: e.message });
      console.log(`FAILED: ${e.message}`);
      if (/system paused|system_paused/i.test(e.message)) {
        console.log("[batch] system paused detected, stopping batch");
        break;
      }
    }
  }

  const summary = aggregate(runs);
  await fs.writeFile(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));

  console.log();
  console.log(fmtTable(runs));
  console.log();
  console.log(`scrape_status histogram: ${JSON.stringify(summary.scrape_status)}`);
  console.log(`error_kind histogram:    ${JSON.stringify(summary.error_kind)}`);
  console.log(`merge_skip_reasons:      ${JSON.stringify(summary.merge_skip_reasons)}`);
  console.log(`rule vs llm:             ${JSON.stringify(summary.rule_vs_llm)} (${summary.rule_ratio}% rule)`);
  console.log(`total spend:             ${summary.cost_cents_total}¢ across ${summary.steps_total} steps (avg ${summary.cost_cents_avg_per_step}¢/step)`);
  console.log();
  console.log(`[batch] full output: ${outDir}`);
}

main().catch((e) => {
  console.error(e.stack || e);
  process.exit(1);
});
