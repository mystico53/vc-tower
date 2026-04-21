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
  // Google Gemini (orchestrator + extractor) via OpenAI compatibility endpoint.
  // Used through the `openai` SDK with baseURL pointed at Google's compat layer.
  get GEMINI_API_KEY() { return required("GEMINI_API_KEY"); },
  get GEMINI_BASE_URL() {
    return optional("GEMINI_BASE_URL", "https://generativelanguage.googleapis.com/v1beta/openai/");
  },
  get GEMINI_MODEL() { return optional("GEMINI_MODEL", "gemini-3-flash-preview"); },
  // Split roles so decide and extract can be tuned independently.
  // DECIDE_MODEL runs on Gemini (orchestrator reasoning). EXTRACT_MODEL runs
  // on xAI Grok (see XAI_* block below) — chosen for 5x cheaper output tokens
  // and faster TTFT than Gemini Flash, which matters because the extractor is
  // the hot path on every scrape step.
  get DECIDE_MODEL() { return optional("DECIDE_MODEL", this.GEMINI_MODEL); },
  get EXTRACT_MODEL() { return optional("EXTRACT_MODEL", "grok-4-1-fast-non-reasoning"); },

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
  get XAI_BASE_URL() { return optional("XAI_BASE_URL", "https://api.x.ai/v1"); },
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
  // Dead-letter threshold. Rows whose `zero_progress_streak` reaches this
  // count are classified as dead_letter and dropped from the play-scrape
  // candidate pool. Reset by any successful field merge. Kept low by default
  // so truly broken profiles stop burning credits after a single retry cycle.
  get DEAD_LETTER_STREAK() { return optionalInt("DEAD_LETTER_STREAK", 3); },

  // Dev-only harness auth. When set + NODE_ENV !== production, /api/step/harness
  // accepts x-dev-key headers matching this value. Leave blank to disable the
  // harness entirely, even in dev.
  get HARNESS_DEV_KEY() { return optional("HARNESS_DEV_KEY", ""); },
};
