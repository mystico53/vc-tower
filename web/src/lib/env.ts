// Server-only env access. Throws eagerly with a clear error if a required
// variable is missing — prevents silent `undefined` reaching a tool adapter.

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

function optionalInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) throw new Error(`Env var ${name} must be an integer, got: ${v}`);
  return n;
}

export const env = {
  // DashScope / Qwen (orchestrator + extractor)
  get DASHSCOPE_API_KEY() { return required("DASHSCOPE_API_KEY"); },
  get DASHSCOPE_BASE_URL() {
    return optional("DASHSCOPE_BASE_URL", "https://dashscope-intl.aliyuncs.com/compatible-mode/v1");
  },
  get DASHSCOPE_MODEL() { return optional("DASHSCOPE_MODEL", "qwen-plus-2025-09-11"); },

  // Firecrawl
  get FIRECRAWL_API_KEY() { return required("FIRECRAWL_API_KEY"); },

  // Apify LinkedIn actors
  get APIFY_TOKEN() { return required("APIFY_TOKEN"); },
  get APIFY_LINKEDIN_PROFILE_ACTOR() {
    return optional("APIFY_LINKEDIN_PROFILE_ACTOR", "supreme_coder/linkedin-profile-scraper");
  },
  get APIFY_LINKEDIN_COMPANY_ACTOR() {
    return optional("APIFY_LINKEDIN_COMPANY_ACTOR", "data-slayer/linkedin-company-scraper");
  },

  // xAI Grok
  get XAI_API_KEY() { return required("XAI_API_KEY"); },
  get XAI_MODEL() { return optional("XAI_MODEL", "grok-4-1-fast"); },
  // Kill switch for the grok_x_lookup tool. Each call costs ~1-5¢ in x_search
  // credits; set GROK_X_LOOKUP_ENABLED=false to drop it from the orchestrator
  // catalog entirely (no effect on existing step data).
  get GROK_X_LOOKUP_ENABLED() {
    return optional("GROK_X_LOOKUP_ENABLED", "true") === "true";
  },

  // Budget caps (per row)
  get STEP_MAX_PER_ROW() { return optionalInt("STEP_MAX_PER_ROW", 5); },
  get STEP_BUDGET_CENTS_PER_ROW() { return optionalInt("STEP_BUDGET_CENTS_PER_ROW", 10); },

  // Dev-only harness auth. When set + NODE_ENV !== production, /api/step/harness
  // accepts x-dev-key headers matching this value. Leave blank to disable the
  // harness entirely, even in dev.
  get HARNESS_DEV_KEY() { return optional("HARNESS_DEV_KEY", ""); },
};
