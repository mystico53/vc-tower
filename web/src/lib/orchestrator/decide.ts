import OpenAI from "openai";
import { env } from "@/lib/env";
import type { MissingField, Row } from "@/lib/firestore/schema";
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
  >;
  missingFields: MissingField[];
  stepsTaken: Array<{
    tool: string | null;
    status: string;
    filled: string[];
    extracted_count?: number;
    url?: string | null;
    discovered_links?: string[];
  }>;
  urlsScraped: string[];
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
    apiKey: env.DASHSCOPE_API_KEY,
    baseURL: env.DASHSCOPE_BASE_URL,
  });
}

function buildUserMessage(input: OrchestratorInput): string {
  return JSON.stringify(
    {
      row: input.row,
      missing_fields: input.missingFields,
      steps_taken: input.stepsTaken,
      urls_scraped: input.urlsScraped,
      budget_cents_remaining: input.budgetCentsRemaining,
    },
    null,
    2,
  );
}

// One-shot tool choice. Qwen must respond with a tool_call; if it returns
// free text instead we retry once with a stronger nudge.
export async function decide(input: OrchestratorInput): Promise<OrchestratorOutput> {
  const client = buildClient();

  const callOnce = async (extraNudge: string | null) => {
    const res = await client.chat.completions.create({
      model: env.DASHSCOPE_MODEL,
      temperature: 0,
      tools: enabledTools(),
      tool_choice: "required",
      messages: [
        { role: "system", content: DECIDE_SYSTEM_PROMPT },
        { role: "user", content: buildUserMessage(input) },
        ...(extraNudge
          ? [{ role: "user" as const, content: extraNudge }]
          : []),
      ],
    });
    return res;
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

  const reasoning = typeof args.reasoning === "string" ? args.reasoning : "";
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
