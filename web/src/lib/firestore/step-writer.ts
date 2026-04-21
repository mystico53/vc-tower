import type { Firestore } from "firebase-admin/firestore";
import { env } from "@/lib/env";
import { computeCompletenessScore, computeMissingFields } from "./missing-fields";
import { paths, type Row, type StepStatus } from "./schema";
import type { ExtractedDelta } from "@/lib/orchestrator/extract";

// Per-field confidence floor. Identity fields (email/linkedin/website/twitter)
// need very high confidence because a wrong value is toxic — future extractions
// anchor on them. investor_type drives tool selection (linkedin_profile vs
// linkedin_company) so a wrong label cascades. Everything else uses the default
// floor of 0.5.
const FIELD_CONFIDENCE_FLOORS: Record<string, number> = {
  email: 0.9,
  linkedin: 0.9,
  website: 0.9,
  twitter: 0.9,
  investor_type: 0.8,
};
const DEFAULT_CONFIDENCE_FLOOR = 0.5;

function confidenceFloor(field: string): number {
  return FIELD_CONFIDENCE_FLOORS[field] ?? DEFAULT_CONFIDENCE_FLOOR;
}

// Contact fields are seed identity data — once the ingest or a prior fill set
// a value, later scrapes should never overwrite it. Otherwise a sub-brand
// homepage (e.g. indie.vc) can silently hijack a firm's primary website from
// its extractor output, polluting every subsequent decide call and extraction.
// These fields can still fill an empty slot.
const IMMUTABLE_ONCE_SET = new Set(["email", "website", "linkedin", "twitter"]);

// Deterministic post-merge flags derived from the (already-merged) row state.
// Non-authoritative — purely a dashboard filter convenience. Re-derived every
// step so changes to thesis/check_raw propagate without needing a backfill.
function deriveQualityFlags(row: {
  thesis: string | null;
  check_raw?: string | null;
  check_min_usd: number | null;
  check_max_usd: number | null;
  quality_flags: string[];
}): string[] {
  const preserved = new Set(
    (row.quality_flags ?? []).filter(
      (f) => f !== "operator_led" && f !== "lead_investor" && f !== "solo_check",
    ),
  );
  const thesis = (row.thesis ?? "").toLowerCase();
  const checkRaw = (row.check_raw ?? "").toLowerCase();
  const combined = `${thesis} ${checkRaw}`;

  if (/founders?\s+(first|turned|built)/.test(combined) || /operator-?led/.test(combined)) {
    preserved.add("operator_led");
  }
  if (/\bwe\s+lead\b/.test(combined) || /\blead\s+(pre-?seed|seed|series)\b/.test(combined)) {
    preserved.add("lead_investor");
  }
  const hasMin = row.check_min_usd !== null && row.check_min_usd !== undefined;
  const hasMax = row.check_max_usd !== null && row.check_max_usd !== undefined;
  if (hasMin !== hasMax) preserved.add("solo_check");

  return Array.from(preserved);
}

function zeroPad(n: number, width = 3): string {
  return String(n).padStart(width, "0");
}

export class BudgetExceededError extends Error {
  constructor(public reason: "steps" | "budget") {
    super(`budget exceeded: ${reason}`);
    this.name = "BudgetExceededError";
  }
}

type RunningStepInit = {
  decisionModel: string;
  decisionReasoning: string | null;
  chosenTool: string | null;          // null = stop
  chosenToolArgs: Record<string, unknown>;
};

export type CreatedStep = { idx: number; stepId: string };

// Per-phase wall-clock timings captured by runOneStep. All fields optional so
// stop/error paths can omit phases that didn't run (e.g. tool_ms on stop).
export type StepTimings = {
  decide_ms?: number;
  tool_ms?: number;
  extract_ms?: number;
  total_ms?: number;
};

// Atomically: re-check cap, claim an idx, write a running step doc, and
// increment row.total_steps. The increment here (not on finish) means every
// claimed step counts toward STEP_MAX_PER_ROW even if the tool errors.
export async function createRunningStep(
  db: Firestore,
  projectId: string,
  rowId: string,
  init: RunningStepInit,
): Promise<CreatedStep> {
  return await db.runTransaction(async (tx) => {
    const rowRef = db.doc(paths.row(projectId, rowId));
    const rowSnap = await tx.get(rowRef);
    if (!rowSnap.exists) throw new Error(`row ${rowId} not found`);
    const row = rowSnap.data() as Row;

    if ((row.total_steps ?? 0) >= env.STEP_MAX_PER_ROW) {
      throw new BudgetExceededError("steps");
    }

    const idx = row.total_steps ?? 0;
    const stepId = zeroPad(idx);
    const stepRef = db.doc(paths.step(projectId, rowId, stepId));

    tx.set(stepRef, {
      id: stepId,
      row_id: rowId,
      project_id: projectId,
      idx,
      started_at: new Date().toISOString(),
      finished_at: null,
      status: "running" satisfies StepStatus,
      decision_model: init.decisionModel,
      decision_reasoning: init.decisionReasoning,
      chosen_tool: init.chosenTool,
      chosen_tool_args: init.chosenToolArgs,
      tool_input: {},
      tool_raw_output: null,
      tool_cost_cents: 0,
      extracted_fields: {},
      confidence: {},
      merge_skip_reasons: {},
      error_message: null,
    });

    tx.update(rowRef, { total_steps: idx + 1 });

    return { idx, stepId };
  });
}

type FinishInput = {
  toolInput: Record<string, unknown>;
  toolRawOutput: unknown;
  toolCostCents: number;
  extracted: ExtractedDelta;
  timings?: StepTimings;
};

// Pure outcome of applying an ExtractedDelta to a row. Produced by
// simulateMerge() — no Firestore access, no budget check, no writes.
// Callers map it into a transaction (finishStepAndMergeRow) or into a dry-run
// response (replay endpoint).
export type MergeOutcome = {
  patch: Record<string, unknown>;
  merged: string[];
  skip_reasons: Record<string, string>;
  confidence: Record<string, number>;
};

// Cross-cutting signals derived from the raw tool output that change merge
// policy. Kept separate from `extracted` so simulateMerge stays pure over its
// inputs — callers (finishStepAndMergeRow, replay) must compute the same hints
// deterministically or replay diverges.
export type MergeHints = {
  // Firecrawl/Jina reached a different host than the seed URL *and* the seed
  // URL matched the row's current website. Means `row.website` is a dead
  // redirect (usually rebrand) and should be overwritable this once.
  rebrand_redirect?: boolean;
};

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

// Detect the rebrand-redirect case from a Firecrawl raw response.
// Returns true when sourceURL's host matches the row's existing website host,
// but the final URL resolved to a different host — i.e. the seed URL is a
// 301 to a renamed property. Jina doesn't surface redirect metadata the same
// way, so this is Firecrawl-specific; that's fine, Jina pages don't cause
// this false-skip since Jina only runs on Firecrawl failure.
export function detectRebrandRedirect(
  rawOutput: unknown,
  currentWebsite: string | null | undefined,
): boolean {
  if (!currentWebsite || typeof currentWebsite !== "string") return false;
  const md = (rawOutput as { data?: { metadata?: { sourceURL?: unknown; url?: unknown } } })
    ?.data?.metadata;
  if (!md) return false;
  const sourceURL = typeof md.sourceURL === "string" ? md.sourceURL : null;
  const finalURL = typeof md.url === "string" ? md.url : null;
  if (!sourceURL || !finalURL) return false;
  const sourceHost = hostOf(sourceURL);
  const finalHost = hostOf(finalURL);
  const currentHost = hostOf(currentWebsite);
  if (!sourceHost || !finalHost || !currentHost) return false;
  return sourceHost === currentHost && finalHost !== sourceHost;
}

// Pure merge logic. Given a row + extractor delta, returns what *would* be
// written if we ran the transaction. Factored out of finishStepAndMergeRow so
// the replay endpoint can dry-run extract+merge against stored tool output
// without touching Firestore or paying for tools. Keep in sync with the
// transaction path — behavior MUST match byte-for-byte or replay diverges
// from live runs.
export function simulateMerge(
  row: Row,
  extracted: ExtractedDelta,
  hints: MergeHints = {},
): MergeOutcome {
  const patch: Record<string, unknown> = {};
  const confidence: Record<string, number> = {};
  const merged: string[] = [];
  const skipReasons: Record<string, string> = {};
  const isEmptyExisting = (v: unknown): boolean =>
    v === null ||
    v === undefined ||
    (typeof v === "string" && v.length === 0) ||
    (Array.isArray(v) && v.length === 0);

  for (const [field, delta] of Object.entries(extracted)) {
    if (!delta) continue;
    confidence[field] = delta.confidence;
    if (delta.confidence < confidenceFloor(field)) {
      skipReasons[field] = "confidence_floor";
      continue;
    }
    if (delta.value === null || delta.value === undefined) {
      skipReasons[field] = "null_value";
      continue;
    }

    const existing = (row as unknown as Record<string, unknown>)[field];
    const hasEvidence =
      typeof delta.evidence_quote === "string" && delta.evidence_quote.trim().length > 0;

    // Contact fields are write-once. An already-set website/email/linkedin/
    // twitter is seed identity and must not be overwritten by later scrapes
    // of unrelated sub-brand pages.
    // Exception: if Firecrawl redirected away from the seed website's host
    // (rebrand / dead domain), overwrite `website` once — the seed is no
    // longer reachable and every future scrape would otherwise keep paying
    // for the same redirect. Other contact fields are unaffected since a
    // domain redirect doesn't invalidate an email/linkedin/twitter.
    const websiteRebrandOverride = field === "website" && hints.rebrand_redirect === true;
    if (
      IMMUTABLE_ONCE_SET.has(field) &&
      !isEmptyExisting(existing) &&
      !websiteRebrandOverride
    ) {
      skipReasons[field] = "immutable_contact";
      continue;
    }

    // investor_type is fill-empty-only. The CSV seed or a prior scrape set
    // it to something specific; a later page's off-hand "we advise founders"
    // language shouldn't flip a vc_firm into a contact. "unknown" is treated
    // as empty — that's the default, not an informed choice.
    if (
      field === "investor_type" &&
      typeof existing === "string" &&
      existing.length > 0 &&
      existing !== "unknown"
    ) {
      skipReasons[field] = "type_already_known";
      continue;
    }

    // Special case for `portfolio_companies`: keyed union by normalized name.
    // Later scrapes (different portfolio pages, /investments, team bios) often
    // list overlapping + additional companies. Overwriting would lose data;
    // blocking unsourced merges misses legitimate extras. Rules:
    //  - For matched names, fill null url/fund with non-null incoming values
    //    even without evidence — these are safe hints to existing data.
    //  - Only ADD new names when the incoming extraction has an evidence_quote.
    //    Unsourced incoming lists can hallucinate entries from bio prose
    //    (e.g. Tim O'Reilly's board seats) and must not sneak new rows in.
    if (
      field === "portfolio_companies" &&
      Array.isArray(existing) &&
      existing.length > 0 &&
      Array.isArray(delta.value)
    ) {
      type PC = {
        name: string;
        url?: string | null;
        fund?: string | null;
        logo_url?: string | null;
      };
      const existingArr = existing as PC[];
      const cleanUrl = (u: unknown): string | null =>
        typeof u === "string" && /^https?:\/\//i.test(u.trim()) ? u.trim() : null;
      const cleanFund = (f: unknown): string | null =>
        typeof f === "string" && f.trim().length > 0 ? f.trim() : null;

      const incoming = delta.value as Array<{
        name?: unknown;
        url?: unknown;
        fund?: unknown;
        logo_url?: unknown;
      }>;
      const byKey = new Map<
        string,
        { url: string | null; fund: string | null; logo_url: string | null; name: string }
      >();
      for (const p of incoming) {
        if (typeof p?.name !== "string" || p.name.trim().length === 0) continue;
        byKey.set(p.name.trim().toLowerCase(), {
          name: p.name.trim(),
          url: cleanUrl(p.url),
          fund: cleanFund(p.fund),
          logo_url: cleanUrl(p.logo_url),
        });
      }

      const existingKeys = new Set<string>();
      const upgraded: PC[] = existingArr.map((p) => {
        const key = p.name.trim().toLowerCase();
        existingKeys.add(key);
        const hit = byKey.get(key);
        if (!hit) return p;
        const nextUrl = p.url ?? hit.url ?? null;
        const nextFund = p.fund ?? hit.fund ?? null;
        const nextLogo = p.logo_url ?? hit.logo_url ?? null;
        return { ...p, url: nextUrl, fund: nextFund, logo_url: nextLogo };
      });

      const additions: PC[] = [];
      if (hasEvidence) {
        for (const p of incoming) {
          if (typeof p?.name !== "string") continue;
          const key = p.name.trim().toLowerCase();
          if (existingKeys.has(key)) continue;
          additions.push({
            name: p.name.trim(),
            url: cleanUrl(p.url),
            fund: cleanFund(p.fund),
            logo_url: cleanUrl(p.logo_url),
          });
          existingKeys.add(key);
        }
      }

      const upgradedSomething = upgraded.some(
        (u, i) =>
          u.url !== existingArr[i]?.url ||
          u.fund !== existingArr[i]?.fund ||
          u.logo_url !== existingArr[i]?.logo_url,
      );
      if (upgradedSomething || additions.length > 0) {
        patch[field] = [...upgraded, ...additions];
        merged.push(field);
      } else {
        skipReasons[field] = hasEvidence
          ? "portfolio_no_new_names"
          : "portfolio_upgrade_only_noop";
      }
      continue;
    }

    // Special case for `partners`: upgrade titles on existing names instead
    // of overwriting the whole list. A later team/about page scrape commonly
    // adds titles ("Managing Director") that the homepage scrape couldn't
    // know. Never ADD names from an unsourced extraction — Qwen has been
    // caught hallucinating partners from board-seat lists in bios.
    if (
      field === "partners" &&
      Array.isArray(existing) &&
      existing.length > 0 &&
      Array.isArray(delta.value)
    ) {
      const cleanHttpUrl = (u: unknown): string | null =>
        typeof u === "string" && /^https?:\/\//i.test(u.trim()) ? u.trim() : null;
      const incoming = delta.value as Array<{
        name?: string;
        title?: string | null;
        linkedin_url?: string | null;
        photo_url?: string | null;
      }>;
      type Upgrade = {
        title: string | null;
        linkedin_url: string | null;
        photo_url: string | null;
      };
      const byName = new Map<string, Upgrade>();
      for (const p of incoming) {
        if (typeof p?.name !== "string") continue;
        byName.set(p.name.trim().toLowerCase(), {
          title:
            typeof p.title === "string" && p.title.trim().length > 0
              ? p.title.trim()
              : null,
          linkedin_url: cleanHttpUrl(p.linkedin_url),
          photo_url: cleanHttpUrl(p.photo_url),
        });
      }
      const existingArr = existing as Array<{
        name: string;
        title?: string | null;
        linkedin_url?: string | null;
        photo_url?: string | null;
      }>;
      const upgraded = existingArr.map((p) => {
        const hit = byName.get(p.name.trim().toLowerCase());
        if (!hit) return p;
        return {
          ...p,
          title: p.title ?? hit.title ?? null,
          linkedin_url: p.linkedin_url ?? hit.linkedin_url ?? null,
          photo_url: p.photo_url ?? hit.photo_url ?? null,
        };
      });
      const changed = upgraded.some(
        (p, i) =>
          p.title !== existingArr[i]?.title ||
          p.linkedin_url !== existingArr[i]?.linkedin_url ||
          p.photo_url !== existingArr[i]?.photo_url,
      );
      if (changed) {
        patch[field] = upgraded;
        merged.push(field);
      } else {
        skipReasons[field] = "partners_title_only_upgrade";
      }
      continue;
    }

    // Evidence-less merges can only fill empty slots. A field without a
    // source-quote is either (a) coerced from a bare value the model emitted
    // without the FieldDelta wrapper, or (b) the model copied the row
    // summary verbatim and passed it off as an extraction. Either way, it's
    // not safe to overwrite a non-empty field with an unsourced value.
    if (!hasEvidence && !isEmptyExisting(existing)) {
      skipReasons[field] = "unsourced_overwrite";
      continue;
    }

    // Anti-truncation guard: if the row already has a longer string for this
    // text field and the new value is a prefix of it (whitespace-normalized),
    // skip. Catches mid-sentence truncations where a later step re-emits a
    // cut-off thesis/notes/hq_address at high confidence.
    if (typeof delta.value === "string" && typeof existing === "string" && existing.length > delta.value.length) {
      const norm = (s: string) => s.replace(/\s+/g, " ").trim();
      if (norm(existing).startsWith(norm(delta.value))) {
        skipReasons[field] = "anti_truncation";
        continue;
      }
    }

    patch[field] = delta.value;
    merged.push(field);
  }

  return { patch, merged, skip_reasons: skipReasons, confidence };
}

// Pure projection of a MergeOutcome onto a row snapshot. Applies the patch,
// recomputes missing_fields + completeness, and re-derives quality_flags.
// Same shape the transaction produces, in a form replay can reason about.
export function applyMergeToRow(row: Row, outcome: MergeOutcome): Row {
  const patch = outcome.patch;
  const mergedThesis = (patch.thesis as string | null | undefined) ?? row.thesis ?? null;
  const mergedCheckRaw =
    (patch.check_raw as string | null | undefined) ?? row.check_raw ?? null;
  const mergedCheckMin =
    (patch.check_min_usd as number | null | undefined) ?? row.check_min_usd ?? null;
  const mergedCheckMax =
    (patch.check_max_usd as number | null | undefined) ?? row.check_max_usd ?? null;
  const recomputed = computeMissingFields({
    stages: (patch.stages as Row["stages"]) ?? row.stages ?? [],
    sectors_l1: (patch.sectors_l1 as Row["sectors_l1"]) ?? row.sectors_l1 ?? [],
    check_min_usd: mergedCheckMin,
    check_max_usd: mergedCheckMax,
    thesis: mergedThesis,
    email: (patch.email as string | null | undefined) ?? row.email ?? null,
    linkedin: (patch.linkedin as string | null | undefined) ?? row.linkedin ?? null,
    website: (patch.website as string | null | undefined) ?? row.website ?? null,
    countries_invest:
      (patch.countries_invest as Row["countries_invest"]) ?? row.countries_invest ?? [],
    hq_country: (patch.hq_country as string | null | undefined) ?? row.hq_country ?? null,
  });
  const derivedFlags = deriveQualityFlags({
    thesis: mergedThesis,
    check_raw: mergedCheckRaw,
    check_min_usd: mergedCheckMin,
    check_max_usd: mergedCheckMax,
    quality_flags: row.quality_flags ?? [],
  });
  return {
    ...row,
    ...patch,
    missing_fields: recomputed,
    completeness_score: computeCompletenessScore(recomputed),
    quality_flags: derivedFlags,
  } as Row;
}

// Apply a tool's result: merge high-confidence fields into the row, recompute
// missing_fields, bump budget, update step to done. One transaction so concurrent
// writers can't both merge on top of a stale row snapshot.
export async function finishStepAndMergeRow(
  db: Firestore,
  projectId: string,
  rowId: string,
  stepId: string,
  input: FinishInput,
): Promise<{ merged: string[]; skipped: boolean; reason?: string; skip_reasons: Record<string, string> }> {
  return await db.runTransaction(async (tx) => {
    const rowRef = db.doc(paths.row(projectId, rowId));
    const stepRef = db.doc(paths.step(projectId, rowId, stepId));
    const rowSnap = await tx.get(rowRef);
    if (!rowSnap.exists) throw new Error(`row ${rowId} not found`);
    const row = rowSnap.data() as Row;

    const budgetUsed = row.tool_budget_cents_used ?? 0;
    if (budgetUsed + input.toolCostCents > env.STEP_BUDGET_CENTS_PER_ROW) {
      const budgetSkipReasons: Record<string, string> = {};
      for (const field of Object.keys(input.extracted)) budgetSkipReasons[field] = "budget";
      tx.update(stepRef, {
        status: "skipped" satisfies StepStatus,
        finished_at: new Date().toISOString(),
        tool_input: input.toolInput,
        tool_raw_output: input.toolRawOutput,
        tool_cost_cents: input.toolCostCents,
        extracted_fields: input.extracted,
        merge_skip_reasons: budgetSkipReasons,
        error_message: "budget",
        ...(input.timings ? { timings: input.timings } : {}),
      });
      return { merged: [], skipped: true, reason: "budget", skip_reasons: budgetSkipReasons };
    }

    const hints: MergeHints = {
      rebrand_redirect: detectRebrandRedirect(input.toolRawOutput, row.website),
    };
    const outcome = simulateMerge(row, input.extracted, hints);
    const { patch, merged, skip_reasons: skipReasons, confidence } = outcome;
    const nextRow = applyMergeToRow(row, outcome);

    tx.update(rowRef, {
      ...patch,
      missing_fields: nextRow.missing_fields,
      completeness_score: nextRow.completeness_score,
      quality_flags: nextRow.quality_flags,
      tool_budget_cents_used: budgetUsed + input.toolCostCents,
      last_enriched_at: new Date().toISOString(),
    });

    tx.update(stepRef, {
      status: "done" satisfies StepStatus,
      finished_at: new Date().toISOString(),
      tool_input: input.toolInput,
      tool_raw_output: input.toolRawOutput,
      tool_cost_cents: input.toolCostCents,
      extracted_fields: input.extracted,
      confidence,
      merge_skip_reasons: skipReasons,
      ...(input.timings ? { timings: input.timings } : {}),
    });

    return { merged, skipped: false, skip_reasons: skipReasons };
  });
}

type FailStepDetail = {
  errorKind?: string | null;
  errorDetail?: Record<string, unknown> | null;
  toolRawOutput?: unknown;
  timings?: StepTimings;
};

// Mark a step errored. No row mutation. Counters have already been bumped by
// createRunningStep, so repeated failures still hit the per-row cap.
// Optional extras (error_kind, error_detail, tool_raw_output) are persisted
// when provided — these are the structured diagnostic fields the UI and the
// next decide() call rely on to understand *why* the step failed.
export async function failStep(
  db: Firestore,
  projectId: string,
  rowId: string,
  stepId: string,
  errorMessage: string,
  detail: FailStepDetail = {},
): Promise<void> {
  const stepRef = db.doc(paths.step(projectId, rowId, stepId));
  const patch: Record<string, unknown> = {
    status: "error" satisfies StepStatus,
    finished_at: new Date().toISOString(),
    error_message: errorMessage.slice(0, 2000),
  };
  if (detail.errorKind !== undefined) patch.error_kind = detail.errorKind;
  if (detail.errorDetail !== undefined) patch.error_detail = detail.errorDetail;
  // Persist the full provider response even on failure so Firestore has the
  // raw body to debug against, not just the truncated error string.
  if (detail.toolRawOutput !== undefined) patch.tool_raw_output = detail.toolRawOutput;
  if (detail.timings) patch.timings = detail.timings;
  await stepRef.update(patch);
}

// Record that one client-driven play-scrape batch just ended on this row.
// mergedThisRun = true if any step in the batch merged ≥1 field. Drives the
// dead-letter queue: consecutive zero-merge batches increment the streak
// until it crosses DEAD_LETTER_STREAK, at which point computeScrapeStatus
// flips the row to "dead_letter" and play-scrape-button filters it out.
//
// Called from /api/step/bump-batch at the end of a play loop. Also safe to
// call from cron/scripts/harness — idempotent-ish as long as each batch calls
// it exactly once. Runs in a transaction so concurrent batch drivers can't
// both bump and race the streak.
export async function bumpBatchAttempt(
  db: Firestore,
  projectId: string,
  rowId: string,
  mergedThisRun: boolean,
): Promise<{ batch_attempts: number; zero_progress_streak: number }> {
  return await db.runTransaction(async (tx) => {
    const rowRef = db.doc(paths.row(projectId, rowId));
    const rowSnap = await tx.get(rowRef);
    if (!rowSnap.exists) throw new Error(`row ${rowId} not found`);
    const row = rowSnap.data() as Row;
    const prevAttempts = row.batch_attempts ?? 0;
    const prevStreak = row.zero_progress_streak ?? 0;
    const nextAttempts = prevAttempts + 1;
    const nextStreak = mergedThisRun ? 0 : prevStreak + 1;
    tx.update(rowRef, {
      batch_attempts: nextAttempts,
      zero_progress_streak: nextStreak,
      last_batch_attempt_at: new Date().toISOString(),
    });
    return { batch_attempts: nextAttempts, zero_progress_streak: nextStreak };
  });
}

// Dead-end step for the "stop" path. Qwen decided not to run any tool.
// Written as "done" in a single transaction — there's no tool call, so the
// running→done two-phase write `createRunningStep` uses for tool paths would
// just create a race window where a killed process leaves the step stuck in
// "running" forever.
export async function writeStopStep(
  db: Firestore,
  projectId: string,
  rowId: string,
  decisionModel: string,
  decisionReasoning: string | null,
  stopReason: string,
  timings?: StepTimings,
): Promise<CreatedStep> {
  return await db.runTransaction(async (tx) => {
    const rowRef = db.doc(paths.row(projectId, rowId));
    const rowSnap = await tx.get(rowRef);
    if (!rowSnap.exists) throw new Error(`row ${rowId} not found`);
    const row = rowSnap.data() as Row;

    if ((row.total_steps ?? 0) >= env.STEP_MAX_PER_ROW) {
      throw new BudgetExceededError("steps");
    }

    const idx = row.total_steps ?? 0;
    const stepId = zeroPad(idx);
    const stepRef = db.doc(paths.step(projectId, rowId, stepId));
    const now = new Date().toISOString();

    tx.set(stepRef, {
      id: stepId,
      row_id: rowId,
      project_id: projectId,
      idx,
      started_at: now,
      finished_at: now,
      status: "done" satisfies StepStatus,
      decision_model: decisionModel,
      decision_reasoning: decisionReasoning,
      chosen_tool: null,
      chosen_tool_args: {},
      tool_input: {},
      tool_raw_output: null,
      tool_cost_cents: 0,
      extracted_fields: {},
      confidence: {},
      merge_skip_reasons: {},
      error_message: stopReason,
      ...(timings ? { timings } : {}),
    });

    tx.update(rowRef, { total_steps: idx + 1 });

    return { idx, stepId };
  });
}
