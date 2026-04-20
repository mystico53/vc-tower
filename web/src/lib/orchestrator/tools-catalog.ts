import type OpenAI from "openai";
import { env } from "@/lib/env";

// OpenAI tool-calling JSON schemas passed to Qwen. One entry per real tool
// plus a sentinel "stop" tool so Qwen can signal stop through the same path.
// Every tool takes `reasoning` so the orchestrator records why it made the
// choice regardless of which branch fires.

type ToolDef = OpenAI.Chat.Completions.ChatCompletionTool;

export const ORCHESTRATOR_TOOLS: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "firecrawl_website",
      description:
        "Scrape a single web page for firm description, thesis, sectors, stages, check size, geo. Usually called first on the row's root website, then again on specific subpages (team, portfolio, about, thesis, companies) or linked external sites when key fields remain missing. Pick the next URL like a human researcher would: whichever page is most likely to answer the remaining missing_fields.",
      parameters: {
        type: "object",
        properties: {
          reasoning: { type: "string" },
          url: {
            type: "string",
            description:
              "Any absolute URL worth scraping. On step 0 this is usually row.website. On later steps, prefer a specific subpage (e.g. /team, /portfolio) or a linked external site surfaced in steps_taken.discovered_links. Do not re-scrape a URL already in steps_taken.urls_scraped.",
          },
        },
        required: ["reasoning", "url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "linkedin_profile",
      description:
        "Scrape a LinkedIn personal profile. Use only for investor_type angel, solo_gp, scout_fund, or contact when row.linkedin is a /in/ URL.",
      parameters: {
        type: "object",
        properties: {
          reasoning: { type: "string" },
          url: { type: "string" },
        },
        required: ["reasoning", "url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "linkedin_company",
      description:
        "Scrape a LinkedIn company page. Use for firm-type rows (vc_firm, cvc, accelerator, pe_firm, ...) when row.linkedin is a /company/ URL.",
      parameters: {
        type: "object",
        properties: {
          reasoning: { type: "string" },
          url: { type: "string" },
        },
        required: ["reasoning", "url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "grok_x_lookup",
      description:
        "Look up the investor's X (Twitter) bio and latest posts via Grok with x_search. Returns the most recent posts regardless of age (dormant accounts like @indievc still yield signal about investing vibe), plus last_post_date so dormancy can be judged downstream. Use when row.twitter is set, or when row has both name and firm_name so Grok can resolve the handle itself.",
      parameters: {
        type: "object",
        properties: {
          reasoning: { type: "string" },
          name: { type: "string" },
          firm: { type: "string" },
          handle: { type: "string", description: "X handle without @, if known." },
        },
        required: ["reasoning", "name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "stop",
      description:
        "Stop enrichment for this row. Use when no remaining tool has the inputs it needs, all missing_fields look filled, or budget is exhausted.",
      parameters: {
        type: "object",
        properties: {
          reasoning: { type: "string" },
          stop_reason: {
            type: "string",
            enum: ["all_filled", "budget", "no_useful_tools"],
          },
        },
        required: ["reasoning", "stop_reason"],
      },
    },
  },
];

// Filtered catalog honoring kill-switch env vars. Call this from decide.ts
// instead of using ORCHESTRATOR_TOOLS directly so tools can be turned off
// without recompiling.
export function enabledTools(): ToolDef[] {
  return ORCHESTRATOR_TOOLS.filter((t) => {
    if (t.type !== "function") return true;
    if (t.function.name === "grok_x_lookup" && !env.GROK_X_LOOKUP_ENABLED) return false;
    return true;
  });
}
