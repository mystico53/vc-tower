import OpenAI from "openai";
import { env } from "@/lib/env";
import type { MissingField, Row } from "@/lib/firestore/schema";
import { decideByRules } from "./decide-rules";
import { rethrowIfUpstream } from "./llm-error";
import { DECIDE_SYSTEM_PROMPT } from "./prompts";
import { enabledTools } from "./tools-catalog";

export type OrchestratorInput = {
  row: Pick<
    Row,
    | "name"
    | "firm_name"
    | "investor_type"
    | "website"
    | "linkedin"
    | "twitter"
    | "email"
    | "x_voice_summary"
  >;
  missingFields: MissingField[];
  stepsTaken: Array<{
    tool: string | null;
    status: string;
    filled: string[];
    extracted_count?: number;
    url?: string | null;
    discovered_links?: string[];
    // Populated on failed steps from the Firestore doc — lets the decide
    // prompt branch on "invented_url" / "dead_host" / "rate_limit" / etc.
    error_kind?: string | null;
  }>;
  urlsScraped: string[];
  // Hostnames proven unreachable on a prior step (DNS failure or equivalent).
  // The decider must not pick a firecrawl_website url on one of these hosts —
  // every subpath will DNS-fail too. Prefer a non-web tool or stop.
  deadHosts: string[];
  budgetCentsRemaining: number;
};

export type OrchestratorOutput = {
  reasoning: string;
  next_action: "tool" | "stop";
  tool: string | null;
  tool_args: Record<string, unknown>;
  stop_reason: "all_filled" | "budget" | "no_useful_tools" | null;
  raw_response: unknown;
};

function buildClient(): OpenAI {
  return new OpenAI({
    apiKey: env.GEMINI_API_KEY,
    baseURL: env.GEMINI_BASE_URL,
  });
}

// A LinkedIn URL in row.website is almost always mis-ingested data (the
// source sheet slipped the LinkedIn link into the website column). If we
// leave it in the row payload, the decider either scrapes linkedin.com via
// firecrawl (returns a login wall) or — worse — invents a plausible-looking
// real domain and hands it to firecrawl, wasting a step on DNS failure.
// Passing website: null forces the decider down the linkedin_company /
// web_search path instead of guessing.
function sanitizeWebsite(url: string | null): string | null {
  if (!url) return null;
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host === "linkedin.com" || host.endsWith(".linkedin.com")) return null;
  } catch {
    return null;
  }
  return url;
}

function buildUserMessage(input: OrchestratorInput): string {
  const sanitizedRow = {
    ...input.row,
    website: sanitizeWebsite(input.row.website),
  };
  return JSON.stringify(
    {
      row: sanitizedRow,
      missing_fields: input.missingFields,
      steps_taken: input.stepsTaken,
      urls_scraped: input.urlsScraped,
      dead_hosts: input.deadHosts,
      budget_cents_remaining: input.budgetCentsRemaining,
    },
    null,
    2,
  );
}

// Entry point. First run the deterministic rules — if they return a concrete
// decision, skip the Dashscope call entirely and return it. Most step-0
// firecrawls, budget-floor stops, all-filled stops, and dead-site pivots
// resolve here. When the rules flag a judgment call (e.g. which of 6 candidate
// subpages to scrape), fall through to Qwen with the rule hint prepended so
// the LLM only arbitrates the ambiguous piece.
export async function decide(input: OrchestratorInput): Promise<OrchestratorOutput> {
  const rule = decideByRules(input);
  if (rule.decision === "certain") {
    if (rule.next_action === "stop") {
      return {
        reasoning: rule.reasoning,
        next_action: "stop",
        tool: null,
        tool_args: {},
        stop_reason: rule.stop_reason,
        raw_response: { source: "rule" },
      };
    }
    return {
      reasoning: rule.reasoning,
      next_action: "tool",
      tool: rule.tool,
      tool_args: rule.tool_args,
      stop_reason: null,
      raw_response: { source: "rule" },
    };
  }

  return decideByLLM(input, rule.hint);
}

// Gemini-backed decide. Same behavior the pre-rules version had, with the rule
// hint folded into the user message. Kept behind decide() so callers never
// choose between rule path and LLM path — decide() picks the right one.
async function decideByLLM(input: OrchestratorInput, ruleHint: string): Promise<OrchestratorOutput> {
  const client = buildClient();

  const callOnce = async (extraNudge: string | null) => {
    try {
      const res = await client.chat.completions.create({
        model: env.DECIDE_MODEL,
        temperature: 0,
        tools: enabledTools(),
        // Gemini's OpenAI-compat layer documents only "auto"; the retry-with-
        // nudge below covers the rare case where the model returns no tool call.
        tool_choice: "auto",
        messages: [
          { role: "system", content: DECIDE_SYSTEM_PROMPT },
          { role: "user", content: buildUserMessage(input) },
          { role: "user", content: `Rule hint: ${ruleHint}` },
          ...(extraNudge
            ? [{ role: "user" as const, content: extraNudge }]
            : []),
        ],
      });
      return res;
    } catch (e) {
      // 401/402/403/429 from Gemini surface as LLMUpstreamError so
      // runOneStep can trip the global pause. Plain 400s / parse bugs stay
      // as their original error.
      rethrowIfUpstream("decide", e);
    }
  };

  let res = await callOnce(null);
  let toolCall = res.choices[0]?.message.tool_calls?.[0];
  if (!toolCall) {
    res = await callOnce(
      "You must call exactly one tool. If no enrichment tool fits, call the 'stop' tool with a reason.",
    );
    toolCall = res.choices[0]?.message.tool_calls?.[0];
  }
  if (!toolCall || toolCall.type !== "function") {
    throw new Error("orchestrator returned no tool_call after retry");
  }

  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(toolCall.function.arguments || "{}");
  } catch (e) {
    throw new Error(`orchestrator tool args not JSON: ${(e as Error).message}`);
  }

  // Tag LLM-sourced reasoning so downstream tooling can compute the
  // rule-vs-LLM decision ratio without inferring from raw_response. The
  // rule-certain path uses a "[rule] ..." prefix from decideByRules.
  const rawReasoning = typeof args.reasoning === "string" ? args.reasoning : "";
  const reasoning = `[llm] ${rawReasoning}`;
  const name = toolCall.function.name;

  if (name === "stop") {
    const reason = args.stop_reason;
    const valid = reason === "all_filled" || reason === "budget" || reason === "no_useful_tools";
    return {
      reasoning,
      next_action: "stop",
      tool: null,
      tool_args: {},
      stop_reason: valid ? reason : "no_useful_tools",
      raw_response: res,
    };
  }

  const { reasoning: _r, ...restArgs } = args;
  void _r;
  return {
    reasoning,
    next_action: "tool",
    tool: name,
    tool_args: restArgs,
    stop_reason: null,
    raw_response: res,
  };
}
