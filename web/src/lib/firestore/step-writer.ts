import type { Firestore } from "firebase-admin/firestore";
import { env } from "@/lib/env";
import { computeCompletenessScore, computeMissingFields } from "./missing-fields";
import { paths, type Row, type StepStatus } from "./schema";
import type { ExtractedDelta } from "@/lib/orchestrator/extract";

const MERGE_CONFIDENCE_FLOOR = 0.5;

// Contact fields are seed identity data — once the ingest or a prior fill set
// a value, later scrapes should never overwrite it. Otherwise a sub-brand
// homepage (e.g. indie.vc) can silently hijack a firm's primary website from
// its extractor output, polluting every subsequent decide call and extraction.
// These fields can still fill an empty slot.
const IMMUTABLE_ONCE_SET = new Set(["email", "website", "linkedin", "twitter"]);

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
};

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
      });
      return { merged: [], skipped: true, reason: "budget", skip_reasons: budgetSkipReasons };
    }

    // Build merge patch from fields with confidence >= 0.5.
    const patch: Record<string, unknown> = {};
    const confidence: Record<string, number> = {};
    const merged: string[] = [];
    const skipReasons: Record<string, string> = {};
    const isEmptyExisting = (v: unknown): boolean =>
      v === null ||
      v === undefined ||
      (typeof v === "string" && v.length === 0) ||
      (Array.isArray(v) && v.length === 0);

    for (const [field, delta] of Object.entries(input.extracted)) {
      if (!delta) continue;
      confidence[field] = delta.confidence;
      if (delta.confidence < MERGE_CONFIDENCE_FLOOR) {
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
      if (IMMUTABLE_ONCE_SET.has(field) && !isEmptyExisting(existing)) {
        skipReasons[field] = "immutable_contact";
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
        type PC = { name: string; url?: string | null; fund?: string | null };
        const existingArr = existing as PC[];
        const cleanUrl = (u: unknown): string | null =>
          typeof u === "string" && /^https?:\/\//i.test(u.trim()) ? u.trim() : null;
        const cleanFund = (f: unknown): string | null =>
          typeof f === "string" && f.trim().length > 0 ? f.trim() : null;

        const incoming = delta.value as Array<{ name?: unknown; url?: unknown; fund?: unknown }>;
        const byKey = new Map<string, { url: string | null; fund: string | null; name: string }>();
        for (const p of incoming) {
          if (typeof p?.name !== "string" || p.name.trim().length === 0) continue;
          byKey.set(p.name.trim().toLowerCase(), {
            name: p.name.trim(),
            url: cleanUrl(p.url),
            fund: cleanFund(p.fund),
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
          return { ...p, url: nextUrl, fund: nextFund };
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
            });
            existingKeys.add(key);
          }
        }

        const upgradedSomething = upgraded.some(
          (u, i) => u.url !== existingArr[i]?.url || u.fund !== existingArr[i]?.fund,
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
        const incoming = delta.value as Array<{ name?: string; title?: string | null }>;
        const byName = new Map<string, { title: string | null }>();
        for (const p of incoming) {
          if (typeof p?.name !== "string") continue;
          byName.set(p.name.trim().toLowerCase(), {
            title: typeof p.title === "string" && p.title.trim().length > 0 ? p.title.trim() : null,
          });
        }
        const existingArr = existing as Array<{ name: string; title?: string | null }>;
        const upgraded = existingArr.map((p) => {
          const hit = byName.get(p.name.trim().toLowerCase());
          if (hit && hit.title && !p.title) return { ...p, title: hit.title };
          return p;
        });
        const changed =
          upgraded.some((p, i) => p.title !== existingArr[i]?.title);
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

    // Recompute missing_fields against the merged row state.
    const recomputed = computeMissingFields({
      stages: (patch.stages as Row["stages"]) ?? row.stages ?? [],
      sectors_l1: (patch.sectors_l1 as Row["sectors_l1"]) ?? row.sectors_l1 ?? [],
      check_min_usd: (patch.check_min_usd as number | null | undefined) ?? row.check_min_usd ?? null,
      check_max_usd: (patch.check_max_usd as number | null | undefined) ?? row.check_max_usd ?? null,
      thesis: (patch.thesis as string | null | undefined) ?? row.thesis ?? null,
      email: (patch.email as string | null | undefined) ?? row.email ?? null,
      linkedin: (patch.linkedin as string | null | undefined) ?? row.linkedin ?? null,
      website: (patch.website as string | null | undefined) ?? row.website ?? null,
      countries_invest:
        (patch.countries_invest as Row["countries_invest"]) ?? row.countries_invest ?? [],
      hq_country: (patch.hq_country as string | null | undefined) ?? row.hq_country ?? null,
    });

    tx.update(rowRef, {
      ...patch,
      missing_fields: recomputed,
      completeness_score: computeCompletenessScore(recomputed),
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
    });

    return { merged, skipped: false, skip_reasons: skipReasons };
  });
}

// Mark a step errored. No row mutation. Counters have already been bumped by
// createRunningStep, so repeated failures still hit the per-row cap.
export async function failStep(
  db: Firestore,
  projectId: string,
  rowId: string,
  stepId: string,
  errorMessage: string,
): Promise<void> {
  const stepRef = db.doc(paths.step(projectId, rowId, stepId));
  await stepRef.update({
    status: "error" satisfies StepStatus,
    finished_at: new Date().toISOString(),
    error_message: errorMessage.slice(0, 2000),
  });
}

// Dead-end step for the "stop" path. Qwen decided not to run any tool.
export async function writeStopStep(
  db: Firestore,
  projectId: string,
  rowId: string,
  decisionModel: string,
  decisionReasoning: string | null,
  stopReason: string,
): Promise<CreatedStep> {
  const created = await createRunningStep(db, projectId, rowId, {
    decisionModel,
    decisionReasoning,
    chosenTool: null,
    chosenToolArgs: {},
  });
  const stepRef = db.doc(paths.step(projectId, rowId, created.stepId));
  await stepRef.update({
    status: "done" satisfies StepStatus,
    finished_at: new Date().toISOString(),
    error_message: stopReason,
  });
  return created;
}
