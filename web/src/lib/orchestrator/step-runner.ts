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
import { getSystemState, pauseSystem } from "@/lib/firestore/system-pause";
import { scrapeWebsite } from "@/lib/tools/firecrawl";
import { parseHits, searchWeb } from "@/lib/tools/firecrawl-search";
import { scrapeLinkedInCompany, scrapeLinkedInProfile } from "@/lib/tools/apify-linkedin";
import { grokXLookup } from "@/lib/tools/grok-x-search";
import { PAUSE_ON_KINDS, type ToolResult } from "@/lib/tools/types";
import { extract, type ExtractedDelta } from "./extract";
import { decide } from "./decide";
import { LLMUpstreamError } from "./llm-error";

export { DEFAULT_PROJECT_ID };

const STALE_STEP_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes; maxDuration is 60s so anything older is dead

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
  constructor(
    public code: "row_not_found" | "step_cap" | "budget_exhausted" | "system_paused",
    public detail?: unknown,
  ) {
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

// Extract the lowercased hostname from a URL string, or null if unparseable.
// Used to build the dead-hosts blacklist so sibling subpaths on the same dead
// domain get short-circuited before we call the provider again.
export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export async function dispatchTool(
  tool: string,
  args: Record<string, unknown>,
  deadHosts: ReadonlySet<string> = new Set(),
  // Hosts the orchestrator is allowed to hit via firecrawl_website. Built
  // from row.website + every URL in urls_scraped/discovered_links on prior
  // steps. When empty (or on step 0 with no website), firecrawl_website is
  // effectively blocked and the decider must call web_search first.
  allowedHosts: ReadonlySet<string> = new Set(),
): Promise<ToolResult> {
  switch (tool) {
    case "firecrawl_website": {
      const url = typeof args.url === "string" ? args.url : "";
      if (!url) return { ok: false, cost_cents: 0, raw: null, error: "missing url" };
      const host = hostOf(url);
      if (host && deadHosts.has(host)) {
        // Defense-in-depth: even if the decider ignores dead_hosts in its
        // input, we refuse to re-hit a hostname a prior step proved dead.
        return {
          ok: false,
          cost_cents: 0,
          raw: { code: "DEAD_HOST_BLOCKED", host },
          error: `dead_host blocked: ${host} was unreachable on a prior step`,
          error_kind: "dead_host",
          error_detail: { host },
        };
      }
      // URL-provenance guard: Qwen has been caught guessing domains from a
      // firm's name (e.g. "slowventures.com" / "slow.vc" for Slow Ventures —
      // the real domain is slow.co). Prompt rules alone don't stop it.
      // Require the host to trace back to something the orchestrator has
      // actually seen — row.website, a prior scrape, or a prior
      // discovered_link — otherwise reject before we spend a Firecrawl call.
      // allowedHosts being empty means "no legitimate web target exists yet"
      // (null/linkedin-only website, no web_search run), so firecrawl_website
      // is blocked outright until web_search surfaces candidates.
      if (host && !allowedHosts.has(host)) {
        return {
          ok: false,
          cost_cents: 0,
          raw: { code: "INVENTED_URL_BLOCKED", tried_host: host },
          error:
            `invented_url blocked: host "${host}" was not in row.website, urls_scraped, or any prior discovered_links. ` +
            `Call web_search first to discover a real homepage, then scrape a URL from the returned hits.`,
          error_kind: "invented_url",
          error_detail: { tried_host: host, allowed_hosts: [...allowedHosts] },
        };
      }
      return scrapeWebsite(url);
    }
    case "web_search": {
      const query = typeof args.query === "string" ? args.query.trim() : "";
      if (!query) return { ok: false, cost_cents: 0, raw: null, error: "missing query" };
      return searchWeb(query);
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
  // Global kill switch — first thing we check so a paused project can't waste
  // budget even on prior-step self-heal or firestore reads beyond the flag.
  const sys = await getSystemState(db, projectId);
  if (sys.paused) {
    throw new PreCheckError("system_paused", {
      paused_reason: sys.paused_reason,
      paused_tool: sys.paused_tool,
      paused_kind: sys.paused_kind,
      paused_at: sys.paused_at,
    });
  }

  const rowRef = db.doc(paths.row(projectId, rowId));
  const rowSnap = await rowRef.get();
  if (!rowSnap.exists) throw new PreCheckError("row_not_found");
  const row = rowSnap.data() as Row;

  // Self-heal: if the latest step is stuck in "running" beyond the timeout,
  // mark it as errored so this row can progress.
  const latestStepSnap = await db
    .collection(paths.steps(projectId, rowId))
    .orderBy("idx", "desc")
    .limit(1)
    .get();
  if (!latestStepSnap.empty) {
    const latestStep = latestStepSnap.docs[0].data() as Step;
    if (latestStep.status === "running" && latestStep.started_at) {
      const age = Date.now() - Date.parse(latestStep.started_at);
      if (age > STALE_STEP_TIMEOUT_MS) {
        await failStep(db, projectId, rowId, latestStepSnap.docs[0].id, "timeout: step abandoned after 3m");
        await finalizeRow(db, projectId, rowId);
      }
    }
  }

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
  // Hostnames that returned SCRAPE_DNS_RESOLUTION_ERROR on any prior step.
  // Fed into the decider (so it pivots tools) AND into dispatchTool (so the
  // LLM can't re-hit them even if it tries).
  const deadHosts = new Set<string>();
  // Hostnames that the orchestrator is ALLOWED to scrape via firecrawl_website.
  // Seeded below with row.website, then extended per-step with every URL in
  // urls_scraped and discovered_links. Any firecrawl_website call targeting
  // a host not in this set gets rejected as "invented_url" — that's the guard
  // that catches Qwen hallucinating domains (e.g. "slow.vc" for Slow Ventures).
  const allowedHosts = new Set<string>();
  const seedHost = row.website ? hostOf(row.website) : null;
  // Deliberately exclude linkedin.com from the allow-list even if it's in
  // row.website — firecrawl on linkedin.com hits a login wall and the
  // linkedin_company tool is the right path for that host.
  if (seedHost && seedHost !== "linkedin.com" && !seedHost.endsWith(".linkedin.com")) {
    allowedHosts.add(seedHost);
  }
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
      const rawCode =
        s.tool_raw_output && typeof s.tool_raw_output === "object"
          ? (s.tool_raw_output as { code?: unknown }).code
          : null;
      if (
        (rawCode === "SCRAPE_DNS_RESOLUTION_ERROR" || rawCode === "DEAD_HOST_BLOCKED") &&
        argsUrl
      ) {
        const host = hostOf(argsUrl);
        if (host) deadHosts.add(host);
      }
    } else if (s.chosen_tool === "web_search") {
      // Expose the search hits as discovered_links so the decider's next
      // step can pick one and call firecrawl_website on it — same mechanism
      // as same-domain subpages discovered by a real scrape.
      const raw = s.tool_raw_output as { data?: unknown } | null;
      const hits = raw ? parseHits(raw.data) : [];
      discovered_links = hits.map((h) => h.url).slice(0, 10);
    }
    // Extend the firecrawl allow-list with every host the orchestrator has
    // legitimately seen — previously-scraped URLs and any link surfaced as a
    // discovered_link. This is the "provenance" rule: scrape targets must
    // trace back to something real, not a name → guessed domain.
    if (argsUrl) {
      const h = hostOf(argsUrl);
      if (h) allowedHosts.add(h);
    }
    if (discovered_links) {
      for (const link of discovered_links) {
        const h = hostOf(link);
        if (h) allowedHosts.add(h);
      }
    }
    // Total fields the extractor returned (pre-merge). Used by the decide
    // prompt to spot dead sites — 2 consecutive firecrawl steps with 0
    // extracted fields means continuing to scrape subpages is wasted budget.
    const extractedCount = Object.keys((s.extracted_fields as Record<string, unknown>) ?? {}).length;
    // error_kind is persisted on the step doc by failStep — surface it on
    // the summary so the decider can see exactly *why* the last step failed
    // ("invented_url" → call web_search next; "dead_host" → blacklist path
    // already kicked in; "rate_limit" → retry is fine).
    const errorKind =
      s.status === "error" && typeof (s as { error_kind?: unknown }).error_kind === "string"
        ? ((s as unknown as { error_kind: string }).error_kind)
        : null;
    return {
      tool: s.chosen_tool,
      status: s.status,
      filled,
      extracted_count: extractedCount,
      url: argsUrl,
      discovered_links,
      error_kind: errorKind,
    };
  });

  // Decide. Credit/auth/rate-limit errors from Dashscope trip the global
  // pause — if the orchestrator model itself is out of credits, no row on the
  // project can make progress, so stop everyone.
  let decision;
  try {
    decision = await decide({
      row,
      missingFields: row.missing_fields ?? [],
      stepsTaken,
      urlsScraped,
      deadHosts: [...deadHosts],
      budgetCentsRemaining: budgetRemaining,
    });
  } catch (e) {
    if (e instanceof LLMUpstreamError) {
      await pauseSystem(db, projectId, {
        reason: e.message.slice(0, 200),
        tool: `dashscope:${e.stage}`,
        kind: e.error_kind,
      });
      throw new PreCheckError("system_paused", {
        paused_reason: `dashscope ${e.status}`,
        paused_tool: `dashscope:${e.stage}`,
        paused_kind: e.error_kind,
      });
    }
    throw e;
  }

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
    const toolResult = await dispatchTool(toolName, decision.tool_args, deadHosts, allowedHosts);
    if (!toolResult.ok) {
      await failStep(db, projectId, rowId, created.stepId, toolResult.error ?? "tool failed with no message", {
        errorKind: toolResult.error_kind ?? null,
        errorDetail: toolResult.error_detail ?? null,
        // Keep the raw provider body on the step doc even on failure — this
        // is the ONLY place the full Firecrawl/Apify response survives once
        // the request is over, and debugging a dead-host trail without it
        // means re-running the scrape.
        toolRawOutput: toolResult.raw,
      });
      // Credit/auth failures from a paid upstream mean every other in-flight
      // row is about to fail the same way. Flip the global pause before
      // returning so parallel scrapers stop on their next step.
      if (toolResult.error_kind && PAUSE_ON_KINDS.has(toolResult.error_kind)) {
        await pauseSystem(db, projectId, {
          reason: toolResult.error ?? `${toolName} ${toolResult.error_kind}`,
          tool: toolName,
          kind: toolResult.error_kind,
        });
      }
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
    // web_search returns a list of URLs + snippets; there's nothing to extract
    // into the row schema, and calling the extractor wastes a Qwen request on
    // noise. The discovered URLs are surfaced to the next step's decide() via
    // the stepsTaken.discovered_links path instead.
    const shouldExtract = toolName !== "web_search";
    try {
      if (shouldExtract) {
        extracted = await extract({
          raw: toolResult.raw,
          markdown: toolResult.markdown,
          missingFields: row.missing_fields ?? [],
          row,
        });
      }
    } catch (e) {
      const msg = `extract failed: ${(e as Error).message}`;
      await failStep(db, projectId, rowId, created.stepId, msg);
      // Same policy as decide(): Dashscope credit/auth/rate_limit trips the
      // pause. Parse / zod errors from extract stay as a per-row error.
      if (e instanceof LLMUpstreamError) {
        await pauseSystem(db, projectId, {
          reason: e.message.slice(0, 200),
          tool: `dashscope:${e.stage}`,
          kind: e.error_kind,
        });
      }
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
