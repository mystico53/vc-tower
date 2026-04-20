import { env } from "@/lib/env";
import type { ToolResult } from "./types";

type GrokArgs = {
  name: string;
  firm?: string;
  handle?: string;
};

// Grok with the x_search server-side tool on the Responses API. Chat
// Completions' live_search was deprecated 2026-01-12; x_search only exists
// on /v1/responses, and tool config fields now sit flat on the tool object.
// No from_date: accounts like @indievc haven't posted since 2019 but their
// old tweets still carry strong signal — we let Grok pull the latest posts
// regardless of age and flag dormancy downstream from last_post_date.
export async function grokXLookup(args: GrokArgs): Promise<ToolResult> {
  const apiKey = env.XAI_API_KEY;

  const systemPrompt = `You are an investor-profile resolver. Given a name (and optionally firm or handle), use the x_search tool to look up this person on X (Twitter).

SEARCH STRATEGY — this is important:
1. First pull the 10 most recent posts (from:{handle} mode:Latest) for freshness / dormancy.
2. Then ALSO search for older posts that reveal investing philosophy. Many investor accounts have gone quiet recently or pivoted to promo/podcast content, but their older tweets are where the actual worldview lives. Run additional x_keyword_search queries like:
     from:{handle} VC
     from:{handle} founder
     from:{handle} capital OR revenue OR bootstrap
     from:{handle} raise OR funding
     from:{handle} thesis
   Pick the queries that best apply to this account. Aim to see 20-40 posts total across the recent + philosophy searches before writing the summary.
3. If the account has <50 posts total, just pull them all.

Return a single JSON object with these keys:
- handle (string, no @)
- bio (string — from profile)
- last_post_date (string, ISO YYYY-MM-DD — date of the most recent post you found, or null if unknown)
- recent_posts (array of up to 10 objects with shape { date: "YYYY-MM-DD", text: string } — the NEWEST 10 posts, for dormancy and freshness)
- recent_topics (string[] — themes/topics from the posts you saw)
- thesis_clues (string[] — investing philosophy or stage/sector hints inferable from the posts)
- voice_summary (string, 4-7 sentences — a substantive read on WHAT KIND OF INVESTOR THIS IS and WHAT THEY VALUE. Do NOT summarize what they've been posting about or list podcast episodes. Infer their investing stance from the posts. Cover, where the posts support it:
    • What kind of founder or business they gravitate toward (revenue-first? design-obsessed? technical? solo operators? bootstrappers?).
    • Their stance on capital and growth (pro-VC / VC-skeptical / bootstrap-friendly / patient-capital / anti-unicorn-game?).
    • Stage, sector, or geography leanings.
    • Distinctive contrarian takes, dealbreakers, or heterodox opinions. What do they disagree with the mainstream VC view about?
  Ground each claim by quoting or paraphrasing a specific line (add the year when useful, e.g. 'in 2018 he warned that "venture capital should never have become the standard way to fund new businesses"'). If the posts do not reveal a distinctive stance, say so honestly in 1-2 sentences instead of padding.

  WRITING STYLE — this reads like a sharp human analyst, not AI slop. Obey these rules or the summary will be rejected:
    • Use plain "is / are / has". Do not write "serves as", "stands as", "represents a", "marks a", "boasts", "features".
    • No em dashes. Use commas, periods, or parentheses.
    • No AI vocabulary: delve, interplay, landscape (figurative), tapestry, pivotal, crucial, underscore, highlight (as verb), showcase, fostering, enduring, testament, vibrant, groundbreaking, align with, intricate, seamless, robust, key (as adjective). Say the concrete thing instead.
    • No negative parallelism like "not just X, but Y" or "it is not about X, it is about Y".
    • No "-ing" tails added for depth ("emphasizing...", "reflecting...", "contributing to...", "highlighting..."). If a tail does real work, rewrite it as a plain clause.
    • No authority tropes ("at its core", "fundamentally", "the real question is", "what really matters").
    • No rule-of-three lists unless the posts actually group things in threes.
    • No generic VC-speak ("passionate about founders", "empowering builders", "backs great entrepreneurs", "early-stage investor with a keen eye"). Say something another investor could disagree with.
    • No hedging stacks ("could potentially possibly", "may arguably"). Pick one and commit.
    • No generic upbeat closers ("the future looks bright", "exciting times ahead").
    • No curly quotes — use straight " and '.
    • Vary sentence length. Short punchy sentences next to longer ones. Do not write six sentences of the same rhythm.
    • Specific beats vague. "In 2018 he told founders to test demand with a $50 ad spend before building" beats "emphasizes validating demand".
    • First-person reactions are fine if grounded ("reads like a former VC who got sick of the growth-at-all-costs script"). An opinion is fine. Formulaic praise is not.)

Respond with ONLY the JSON object. No prose, no markdown fences.`;

  const xSearchTool: Record<string, unknown> = {
    type: "x_search",
  };
  if (args.handle) xSearchTool.allowed_x_handles = [args.handle];

  const userPrompt = [
    `Name: ${args.name}`,
    args.firm ? `Firm: ${args.firm}` : null,
    args.handle ? `Handle: @${args.handle}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  let res: Response;
  try {
    res = await fetch("https://api.x.ai/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: env.XAI_MODEL,
        temperature: 0,
        tools: [xSearchTool],
        input: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
    });
  } catch (e) {
    return {
      ok: false,
      cost_cents: 0,
      raw: null,
      error: `xai network error: ${(e as Error).message}`,
    };
  }

  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }

  if (!res.ok) {
    return {
      ok: false,
      cost_cents: 0,
      raw: body,
      error: `xai ${res.status}: ${text.slice(0, 300)}`,
    };
  }

  // Estimate cost: per docs/pr2.md:165, ~$0.005–0.015 per row. Round to 1¢.
  return {
    ok: true,
    cost_cents: 1,
    raw: body,
  };
}
