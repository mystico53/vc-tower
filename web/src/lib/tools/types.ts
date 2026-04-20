// Every enrichment tool returns this shape. See docs/pr2.md:128-136.
export type ToolResult = {
  ok: boolean;
  cost_cents: number;
  raw: unknown;            // full provider response; stored on the step doc
  markdown?: string;       // filled by Firecrawl / Jina
  error?: string;
  raw_source?: string;     // e.g. "firecrawl" or "jina" when a fallback fires
};

export type ToolName =
  | "firecrawl_website"
  | "linkedin_profile"
  | "linkedin_company"
  | "grok_x_lookup";
