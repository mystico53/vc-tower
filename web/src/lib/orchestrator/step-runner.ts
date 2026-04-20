import type { Firestore } from "firebase-admin/firestore";
import { env } from "@/lib/env";
import { computeScrapeStatus } from "@/lib/firestore/missing-fields";
import { DEFAULT_PROJECT_ID, paths, type Row, type Step } from "@/lib/firestore/schema";
import {
  BudgetExceededError,
  createRunningStep,
  failStep,
  finishStepAndMergeRow,
  writeStopStep,
} from "@/lib/firestore/step-writer";
import { scrapeWebsite } from "@/lib/tools/firecrawl";
import { scrapeLinkedInCompany, scrapeLinkedInProfile } from "@/lib/tools/apify-linkedin";
import { grokXLookup } from "@/lib/tools/grok-x-search";
import type { ToolResult } from "@/lib/tools/types";
import { decide } from "./decide";
import { extract, type ExtractedDelta } from "./extract";

export { DEFAULT_PROJECT_ID };

export type StepOutcomeStatus = "done" | "skipped" | "error" | "stopped";

export type StepOutcome = {
  stepId: string;
  idx: number;
  status: StepOutcomeStatus;
  decision: {
    reasoning: string;
    tool: string | null;
    args: Record<string, unknown>;
    stop_reason: string | null;
  };
  tool_cost_cents: number;
  tool_error: string | null;
  extracted: ExtractedDelta;
  merged_fields: string[];
  skip_reasons: Record<string, string>;
  row_before: Row;
  row_after: Row;
};

// Thrown by runOneStep when pre-checks fail — lets callers map to HTTP 409.
export class PreCheckError extends Error {
  constructor(public code: "row_not_found" | "step_cap" | "budget_exhausted", public detail?: unknown) {
    super(code);
    this.name = "PreCheckError";
  }
}

export function extractFirecrawlData(raw: unknown): { markdown: string | null; links: string[] } {
  if (!raw || typeof raw !== "object") return { markdown: null, links: [] };
  const data = (raw as { data?: unknown }).data;
  if (!data || typeof data !== "object") return { markdown: null, links: [] };
  const d = data as { markdown?: unknown; links?: unknown };
  const markdown = typeof d.markdown === "string" ? d.markdown : null;
  const links = Array.isArray(d.links)
    ? d.links.filter((x): x is string => typeof x === "string")
    : [];
  return { markdown, links };
}

// Combine firecrawl's structured `links` array (nav + footer + body) with
// anything found in the rendered markdown, normalize, and drop noise so the
// orchestrator sees a tight list of real subpages worth following.
export function collectDiscoveredLinks(
  markdown: string | null,
  firecrawlLinks: string[],
  selfUrl?: string,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const norm = (u: string) => {
    const trimmed = u.trim().replace(/[)\].,;]+$/, "");
    if (!/^https?:\/\//i.test(trimmed)) return null;
    try {
      const parsed = new URL(trimmed);
      parsed.hash = ""; // /team.html#intro and /team.html collapse to one page
      return parsed.toString().replace(/\/$/, "");
    } catch {
      return null;
    }
  };
  const selfNorm = selfUrl ? norm(selfUrl) : null;
  const push = (u: string) => {
    const n = norm(u);
    if (!n || seen.has(n)) return;
    if (selfNorm && n === selfNorm) return;
    if (/\.(png|jpe?g|gif|svg|webp|ico|pdf|zip|mp4|css|js)(\?|$)/i.test(n)) return;
    seen.add(n);
    out.push(n);
  };
  for (const l of firecrawlLinks) push(l);
  if (markdown) {
    const mdRe = /\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/g;
    const bareRe = /<(https?:\/\/[^\s>]+)>/g;
    let m: RegExpExecArray | null;
    while ((m = mdRe.exec(markdown))) push(m[1]);
    while ((m = bareRe.exec(markdown))) push(m[1]);
  }
  return out;
}

export async function dispatchTool(
  tool: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  switch (tool) {
    case "firecrawl_website": {
      const url = typeof args.url === "string" ? args.url : "";
      if (!url) return { ok: false, cost_cents: 0, raw: null, error: "missing url" };
      return scrapeWebsite(url);
    }
    case "linkedin_profile": {
      const url = typeof args.url === "string" ? args.url : "";
      if (!url) return { ok: false, cost_cents: 0, raw: null, error: "missing url" };
      return scrapeLinkedInProfile(url);
    }
    case "linkedin_company": {
      const url = typeof args.url === "string" ? args.url : "";
      if (!url) return { ok: false, cost_cents: 0, raw: null, error: "missing url" };
      return scrapeLinkedInCompany(url);
    }
    case "grok_x_lookup": {
      const name = typeof args.name === "string" ? args.name : "";
      if (!name) return { ok: false, cost_cents: 0, raw: null, error: "missing name" };
      return grokXLookup({
        name,
        firm: typeof args.firm === "string" ? args.firm : undefined,
        handle: typeof args.handle === "string" ? args.handle : undefined,
      });
    }
    default:
      return { ok: false, cost_cents: 0, raw: null, error: `unknown tool: ${tool}` };
  }
}

// Re-read the row's step collection, classify it, and write scrape_status
// back to the row if it changed. Returns the freshest row snapshot for use as
// row_after. Called at every exit path of runOneStep so the list UI reflects
// the latest dead-site / partial / complete state as soon as a step finishes.
async function finalizeRow(
  db: Firestore,
  projectId: string,
  rowId: string,
): Promise<Row> {
  const stepsSnap = await db
    .collection(paths.steps(projectId, rowId))
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
  const rowRef = db.doc(paths.row(projectId, rowId));
  const rowSnap = await rowRef.get();
  const row = rowSnap.data() as Row;
  const { status, reason } = computeScrapeStatus({
    missing: row.missing_fields ?? [],
    steps: classified,
  });
  const statusChanged = status !== (row.scrape_status ?? null);
  const reasonChanged = reason !== (row.scrape_status_reason ?? null);
  if (statusChanged || reasonChanged) {
    await rowRef.update({ scrape_status: status, scrape_status_reason: reason });
    const fresh = await rowRef.get();
    return fresh.data() as Row;
  }
  return row;
}

// Runs one full orchestrator iteration on a row: pre-check budget, load prior
// steps as context, call decide, dispatch the tool (or record a stop), extract,
// merge the row. Returns a structured outcome covering the full state transition.
// Throws PreCheckError when the row is missing or the budget/step cap is already
// hit — callers map that to HTTP 409. Orchestrator/tool failures surface as
// status:"error" with tool_error populated; the step doc is failStep'd.
export async function runOneStep(
  db: Firestore,
  projectId: string,
  rowId: string,
): Promise<StepOutcome> {
  const rowRef = db.doc(paths.row(projectId, rowId));
  const rowSnap = await rowRef.get();
  if (!rowSnap.exists) throw new PreCheckError("row_not_found");
  const row = rowSnap.data() as Row;

  if ((row.total_steps ?? 0) >= env.STEP_MAX_PER_ROW) {
    throw new PreCheckError("step_cap", { total_steps: row.total_steps });
  }
  const budgetUsed = row.tool_budget_cents_used ?? 0;
  const budgetRemaining = Math.max(0, env.STEP_BUDGET_CENTS_PER_ROW - budgetUsed);
  if (budgetRemaining <= 0) {
    throw new PreCheckError("budget_exhausted", { tool_budget_cents_used: budgetUsed });
  }

  // Prior-step summaries — URL + discovered links for firecrawl steps so the
  // orchestrator can follow nav-level subpages rather than only inline links.
  const priorSnap = await db
    .collection(paths.steps(projectId, rowId))
    .orderBy("idx", "asc")
    .get();
  const urlsScraped: string[] = [];
  const stepsTaken = priorSnap.docs.map((d) => {
    const s = d.data() as Step;
    const filled = Object.entries(s.confidence ?? {})
      .filter(([, c]) => typeof c === "number" && c >= 0.5)
      .map(([field]) => field);
    const argsUrl =
      typeof s.chosen_tool_args?.url === "string" ? s.chosen_tool_args.url : null;
    let discovered_links: string[] | undefined;
    if (s.chosen_tool === "firecrawl_website") {
      if (argsUrl) urlsScraped.push(argsUrl);
      const { markdown, links } = extractFirecrawlData(s.tool_raw_output);
      discovered_links = collectDiscoveredLinks(markdown, links, argsUrl ?? undefined).slice(0, 30);
    }
    // Total fields the extractor returned (pre-merge). Used by the decide
    // prompt to spot dead sites — 2 consecutive firecrawl steps with 0
    // extracted fields means continuing to scrape subpages is wasted budget.
    const extractedCount = Object.keys((s.extracted_fields as Record<string, unknown>) ?? {}).length;
    return {
      tool: s.chosen_tool,
      status: s.status,
      filled,
      extracted_count: extractedCount,
      url: argsUrl,
      discovered_links,
    };
  });

  // Decide.
  const decision = await decide({
    row,
    missingFields: row.missing_fields ?? [],
    stepsTaken,
    urlsScraped,
    budgetCentsRemaining: budgetRemaining,
  });

  const baseDecision = {
    reasoning: decision.reasoning,
    tool: decision.tool,
    args: decision.tool_args ?? {},
    stop_reason: decision.stop_reason ?? null,
  };

  // Stop path.
  if (decision.next_action === "stop") {
    const stop = await writeStopStep(
      db,
      projectId,
      rowId,
      env.DASHSCOPE_MODEL,
      decision.reasoning,
      decision.stop_reason ?? "no_useful_tools",
    );
    const rowAfter = await finalizeRow(db, projectId, rowId);
    return {
      stepId: stop.stepId,
      idx: stop.idx,
      status: "stopped",
      decision: baseDecision,
      tool_cost_cents: 0,
      tool_error: null,
      extracted: {},
      merged_fields: [],
      skip_reasons: {},
      row_before: row,
      row_after: rowAfter,
    };
  }

  // Tool path.
  const created = await createRunningStep(db, projectId, rowId, {
    decisionModel: env.DASHSCOPE_MODEL,
    decisionReasoning: decision.reasoning,
    chosenTool: decision.tool,
    chosenToolArgs: decision.tool_args,
  });

  const toolName = decision.tool!;
  try {
    const toolResult = await dispatchTool(toolName, decision.tool_args);
    if (!toolResult.ok) {
      await failStep(db, projectId, rowId, created.stepId, toolResult.error ?? "tool failed with no message");
      const rowAfter = await finalizeRow(db, projectId, rowId);
      return {
        stepId: created.stepId,
        idx: created.idx,
        status: "error",
        decision: baseDecision,
        tool_cost_cents: toolResult.cost_cents ?? 0,
        tool_error: toolResult.error ?? "tool failed",
        extracted: {},
        merged_fields: [],
        skip_reasons: {},
        row_before: row,
        row_after: rowAfter,
      };
    }

    let extracted: ExtractedDelta = {};
    try {
      extracted = await extract({
        raw: toolResult.raw,
        markdown: toolResult.markdown,
        missingFields: row.missing_fields ?? [],
        row,
      });
    } catch (e) {
      const msg = `extract failed: ${(e as Error).message}`;
      await failStep(db, projectId, rowId, created.stepId, msg);
      const rowAfter = await finalizeRow(db, projectId, rowId);
      return {
        stepId: created.stepId,
        idx: created.idx,
        status: "error",
        decision: baseDecision,
        tool_cost_cents: toolResult.cost_cents ?? 0,
        tool_error: msg,
        extracted: {},
        merged_fields: [],
        skip_reasons: {},
        row_before: row,
        row_after: rowAfter,
      };
    }

    const finished = await finishStepAndMergeRow(db, projectId, rowId, created.stepId, {
      toolInput: decision.tool_args,
      toolRawOutput: toolResult.raw,
      toolCostCents: toolResult.cost_cents,
      extracted,
    });

    const rowAfter = await finalizeRow(db, projectId, rowId);
    return {
      stepId: created.stepId,
      idx: created.idx,
      status: finished.skipped ? "skipped" : "done",
      decision: baseDecision,
      tool_cost_cents: toolResult.cost_cents,
      tool_error: null,
      extracted,
      merged_fields: finished.merged,
      skip_reasons: finished.skip_reasons ?? {},
      row_before: row,
      row_after: rowAfter,
    };
  } catch (e) {
    if (e instanceof BudgetExceededError) {
      // Propagated from createRunningStep after another writer beat us to it.
      throw e;
    }
    const msg = `route handler threw: ${(e as Error).message}`;
    await failStep(db, projectId, rowId, created.stepId, msg);
    const rowAfter = await finalizeRow(db, projectId, rowId);
    return {
      stepId: created.stepId,
      idx: created.idx,
      status: "error",
      decision: baseDecision,
      tool_cost_cents: 0,
      tool_error: msg,
      extracted: {},
      merged_fields: [],
      skip_reasons: {},
      row_before: row,
      row_after: rowAfter,
    };
  }
}
