import type { OrchestratorInput } from "./decide";

// Deterministic half of decide(). Given the same OrchestratorInput the LLM
// sees, returns either a concrete decision (tool + args, or stop + reason)
// or a short hint to feed the LLM when the call is a judgment question.
//
// Why a rules layer exists:
//   Most decide() calls are deterministic — "scrape row.website first",
//   "budget is zero, stop", "all fields filled, stop", "last two firecrawls
//   produced nothing, pivot off web". Letting Qwen arbitrate these wastes
//   a Dashscope call per step and introduces prompt-misread failures on
//   calls that have exactly one correct answer. The LLM is retained for
//   the questions where it actually helps: which of 6 subpages to scrape
//   next, whether a specific search hit looks like the right homepage,
//   etc. Those paths return { decision: "fallback_to_llm", hint: ... }.

export type RuleDecision =
  | {
      decision: "certain";
      next_action: "tool";
      tool:
        | "firecrawl_website"
        | "linkedin_profile"
        | "linkedin_company"
        | "grok_x_lookup"
        | "vcsheet_lookup";
      tool_args: Record<string, unknown>;
      reasoning: string;
    }
  | {
      decision: "certain";
      next_action: "stop";
      stop_reason: "all_filled" | "budget" | "no_useful_tools";
      reasoning: string;
    }
  | {
      decision: "fallback_to_llm";
      hint: string;
    };

const FIRECRAWL_COST_CENTS = 1;
const GROK_MIN_BUDGET_CENTS = 5;
const LINKEDIN_MIN_BUDGET_CENTS = 3;

// error_kinds that mean "this firecrawl step produced no useful content"
// and should count against the dead-site pivot just like extracted_count===0.
const ZERO_YIELD_ERROR_KINDS = new Set([
  "empty_content",
  "js_required",
  "auth_wall",
  "dead_host",
  "invented_url",
]);

function isHttpUrl(u: string | null | undefined): u is string {
  if (typeof u !== "string") return false;
  return /^https?:\/\//i.test(u);
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function isLinkedInHost(host: string | null): boolean {
  if (!host) return false;
  return host === "linkedin.com" || host.endsWith(".linkedin.com");
}

function lastFirecrawlSteps(stepsTaken: OrchestratorInput["stepsTaken"], n: number) {
  return stepsTaken.filter((s) => s.tool === "firecrawl_website").slice(-n);
}

function firecrawlStepIsZeroYield(s: OrchestratorInput["stepsTaken"][number]): boolean {
  if (typeof s.extracted_count === "number" && s.extracted_count === 0) return true;
  if (s.status === "error") {
    if (!s.error_kind) return true; // generic error counts as zero
    return ZERO_YIELD_ERROR_KINDS.has(s.error_kind);
  }
  return false;
}

function hasPriorStepOfTool(stepsTaken: OrchestratorInput["stepsTaken"], tool: string): boolean {
  return stepsTaken.some((s) => s.tool === tool);
}

// Grok can run if the row has a handle OR both name and firm_name to resolve
// the handle itself. Matches the prompt contract (prompts.ts:88).
function grokInputsPresent(row: OrchestratorInput["row"]): boolean {
  if (typeof row.twitter === "string" && row.twitter.length > 0) return true;
  if (
    typeof row.name === "string" &&
    row.name.length > 0 &&
    typeof row.firm_name === "string" &&
    row.firm_name.length > 0
  )
    return true;
  return false;
}

// Grok pivot args — same shape extract() + dispatchTool() want.
function grokArgs(row: OrchestratorInput["row"]): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  if (typeof row.name === "string" && row.name.length > 0) args.name = row.name;
  else if (typeof row.firm_name === "string" && row.firm_name.length > 0) args.name = row.firm_name;
  if (typeof row.firm_name === "string" && row.firm_name.length > 0) args.firm = row.firm_name;
  if (typeof row.twitter === "string" && row.twitter.length > 0) {
    args.handle = row.twitter.replace(/^@+/, "").replace(/^https?:\/\/(?:www\.)?(?:twitter|x)\.com\//i, "");
  }
  return args;
}

function linkedInToolForUrl(url: string): "linkedin_profile" | "linkedin_company" | null {
  const u = url.toLowerCase();
  if (u.includes("/company/") || u.includes("/school/")) return "linkedin_company";
  if (u.includes("/in/")) return "linkedin_profile";
  // Ambiguous (rare) — let the LLM pick.
  return null;
}

export function decideByRules(input: OrchestratorInput): RuleDecision {
  const { row, missingFields, stepsTaken, urlsScraped, deadHosts, budgetCentsRemaining } = input;
  const deadHostSet = new Set(deadHosts);

  // 1. Budget floor. If there's not enough to buy anything useful, stop.
  if (budgetCentsRemaining < FIRECRAWL_COST_CENTS) {
    return {
      decision: "certain",
      next_action: "stop",
      stop_reason: "budget",
      reasoning: `[rule] budget_remaining=${budgetCentsRemaining}¢ below firecrawl floor`,
    };
  }

  // 2. All-filled. Only certain when grok has already run (or can't run) —
  // x_voice_summary isn't in missing_fields but the prompt contract (prompts.ts:31)
  // says to call grok once on rows with a twitter handle before stopping.
  const grokAlreadyRan = hasPriorStepOfTool(stepsTaken, "grok_x_lookup");
  const grokNotPossible = !grokInputsPresent(row);
  const grokAlreadyFilled = typeof row.x_voice_summary === "string" && row.x_voice_summary.length > 0;
  const grokSatisfied = grokAlreadyRan || grokNotPossible || grokAlreadyFilled;
  if (missingFields.length === 0 && grokSatisfied) {
    return {
      decision: "certain",
      next_action: "stop",
      stop_reason: "all_filled",
      reasoning: "[rule] missing_fields empty and grok already satisfied",
    };
  }

  // 3. Step-0 firecrawl on row.website. If nothing has been scraped and the
  // row has a real http(s) non-linkedin website, this is the one deterministic
  // choice prompts.ts:22-23 already requires.
  const websiteHost = typeof row.website === "string" ? hostOf(row.website) : null;
  const websiteUsable =
    isHttpUrl(row.website) &&
    websiteHost !== null &&
    !isLinkedInHost(websiteHost) &&
    !deadHostSet.has(websiteHost);
  if (urlsScraped.length === 0 && websiteUsable) {
    return {
      decision: "certain",
      next_action: "tool",
      tool: "firecrawl_website",
      tool_args: { url: row.website as string },
      reasoning: "[rule] step 0: firecrawl row.website before anything else",
    };
  }

  // 4. Dead-site pivot. After two zero-yield firecrawl steps in a row (empty
  // markdown / js_required / auth_wall / dead_host / error with no extraction),
  // further same-domain scraping wastes budget. Pivot or stop.
  const recentFc = lastFirecrawlSteps(stepsTaken, 2);
  const twoZeroFcs = recentFc.length >= 2 && recentFc.every(firecrawlStepIsZeroYield);

  // 5. LinkedIn pivot. Applicable either as a first-choice tool when firecrawl
  // isn't viable OR as the dead-site pivot target. Gate on url shape, budget,
  // not-already-tried.
  const linkedInUrl = typeof row.linkedin === "string" ? row.linkedin : null;
  const linkedInTool = linkedInUrl ? linkedInToolForUrl(linkedInUrl) : null;
  const linkedInPrior =
    hasPriorStepOfTool(stepsTaken, "linkedin_company") ||
    hasPriorStepOfTool(stepsTaken, "linkedin_profile");
  const linkedInAffordable = budgetCentsRemaining >= LINKEDIN_MIN_BUDGET_CENTS;
  const linkedInAvailable =
    linkedInUrl !== null &&
    linkedInTool !== null &&
    !linkedInPrior &&
    linkedInAffordable;

  // 6. Grok pivot.
  const grokAvailable =
    !grokAlreadyRan &&
    grokInputsPresent(row) &&
    !grokAlreadyFilled &&
    budgetCentsRemaining >= GROK_MIN_BUDGET_CENTS;

  // VCSheet rescue eligibility. VCSheet carries stages + check size as
  // structured fields and is one of the few public sources that does — worth
  // trying when those two specifically remain missing, provided the firm has
  // a usable name to slug from. Only once per row.
  const stagesMissing = missingFields.includes("stages");
  const checkRangeMissing = missingFields.includes("check_range");
  const needsVcsheetFields = stagesMissing || checkRangeMissing;
  const vcsheetPrior = hasPriorStepOfTool(stepsTaken, "vcsheet_lookup");
  const vcsheetFirm =
    typeof row.firm_name === "string" && row.firm_name.length > 0
      ? row.firm_name
      : typeof row.name === "string" && row.name.length > 0
        ? row.name
        : null;
  const vcsheetAvailable =
    needsVcsheetFields &&
    !vcsheetPrior &&
    vcsheetFirm !== null &&
    budgetCentsRemaining >= FIRECRAWL_COST_CENTS;

  if (twoZeroFcs) {
    if (linkedInAvailable) {
      return {
        decision: "certain",
        next_action: "tool",
        tool: linkedInTool!,
        tool_args: { url: linkedInUrl! },
        reasoning: "[rule] dead-site pivot: 2 zero-yield firecrawls → linkedin",
      };
    }
    if (grokAvailable) {
      return {
        decision: "certain",
        next_action: "tool",
        tool: "grok_x_lookup",
        tool_args: grokArgs(row),
        reasoning: "[rule] dead-site pivot: 2 zero-yield firecrawls → grok",
      };
    }
    if (vcsheetAvailable) {
      return {
        decision: "certain",
        next_action: "tool",
        tool: "vcsheet_lookup",
        tool_args: { firm_name: vcsheetFirm! },
        reasoning: "[rule] dead-site pivot: 2 zero-yield firecrawls → vcsheet",
      };
    }
    return {
      decision: "certain",
      next_action: "stop",
      stop_reason: "no_useful_tools",
      reasoning: "[rule] dead-site after 2 zero-yield firecrawls; no pivot target",
    };
  }

  // 7. All-filled but grok still unexhausted → grok pivot.
  if (missingFields.length === 0 && !grokSatisfied && grokAvailable) {
    return {
      decision: "certain",
      next_action: "tool",
      tool: "grok_x_lookup",
      tool_args: grokArgs(row),
      reasoning: "[rule] missing_fields empty but grok not yet run",
    };
  }

  // 7b. VCSheet rescue for stages/check_range. When the easy sources have
  // been exhausted (linkedin already ran or isn't applicable, grok either ran
  // or isn't applicable) and stages/check_range are still missing, VCSheet
  // is the last structured source worth trying. Fires on any step past 0 so
  // it doesn't cut in front of the step-0 firecrawl.
  const linkedInExhausted = linkedInPrior || !linkedInAvailable;
  const grokExhausted = grokAlreadyRan || !grokInputsPresent(row) || grokAlreadyFilled;
  if (
    stepsTaken.length > 0 &&
    vcsheetAvailable &&
    linkedInExhausted &&
    grokExhausted
  ) {
    return {
      decision: "certain",
      next_action: "tool",
      tool: "vcsheet_lookup",
      tool_args: { firm_name: vcsheetFirm },
      reasoning: "[rule] stages/check_range still missing after linkedin+grok → vcsheet",
    };
  }

  // 8. No-website rows: the LLM needs to pick a good web_search query. Rules
  // can detect the state but can't phrase the query — hand off.
  if (urlsScraped.length === 0 && !websiteUsable) {
    return {
      decision: "fallback_to_llm",
      hint:
        websiteHost && deadHostSet.has(websiteHost)
          ? "row.website host is in dead_hosts. Call web_search to discover a working homepage, or pivot to linkedin/grok."
          : "row.website is unusable (null, LinkedIn, or unparseable). Call web_search with a firm-name query to find a real homepage, OR use linkedin/grok if those inputs are present.",
    };
  }

  // 9. Everything else is a judgment call: which of the remaining
  // discovered_links / subpages / external sites to scrape next. That's the
  // part the LLM is actually better at than regex path-ranking.
  return {
    decision: "fallback_to_llm",
    hint:
      twoZeroFcs
        ? "Last firecrawls yielded nothing and no cheap pivot target exists. Consider stopping."
        : "Several candidate tools/URLs remain. Pick the one most likely to fill a missing_field per the prompt rules.",
  };
}
