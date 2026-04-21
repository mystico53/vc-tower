import { z } from "zod";

// Enums mirror the canonical values in scripts/build_masterlist.py.
// Kept permissive (strings + known enums) so the UI doesn't break when
// the Python pipeline adds new values — orchestrator validates later.

export const InvestorType = z.enum([
  "vc_firm", "cvc", "family_office", "pe_firm", "sovereign_fund",
  "angel", "angel_group", "syndicate",
  "accelerator", "incubator", "studio",
  "solo_gp", "rolling_fund", "scout_fund",
  "contact", "unknown",
]);
export type InvestorType = z.infer<typeof InvestorType>;

export const CanonicalStage = z.enum([
  "pre_seed", "seed", "seed_plus",
  "series_a", "series_b", "series_c", "series_d", "series_e_plus",
  "growth", "bridge",
]);
export type CanonicalStage = z.infer<typeof CanonicalStage>;

export const MissingField = z.enum([
  "stages", "sectors", "check_range", "thesis", "any_contact", "geo",
]);
export type MissingField = z.infer<typeof MissingField>;

// Row = one investor. Schema matches the masterlist.db investors table.
export const Row = z.object({
  id: z.string(), // string-form of the SQLite integer id
  source: z.string(),
  source_row: z.number().nullable(),

  investor_type: InvestorType.default("unknown"),
  kind_raw: z.string().nullable(),

  // Identity
  name: z.string().nullable(),
  person_first: z.string().nullable(),
  person_last: z.string().nullable(),
  firm_name: z.string().nullable(),

  // Contact
  email: z.string().nullable(),
  linkedin: z.string().nullable(),
  website: z.string().nullable(),
  twitter: z.string().nullable(),

  // Firm logo URL — populated by the extractor from LinkedIn company payloads
  // (logo_url / company_logo) or OG image tags on the firm site. The drawer
  // prefers this over the Google favicon fallback when present.
  logo_url: z.string().nullable().default(null),

  // Geography
  hq_address: z.string().nullable(),
  hq_country: z.string().nullable(),           // ISO-2
  countries_invest: z.array(z.string()).default([]),

  // Sectors
  sectors_l1: z.array(z.string()).default([]),
  sectors_l2: z.array(z.string()).default([]),
  sectors_raw: z.string().nullable(),

  // Stages
  stages: z.array(CanonicalStage).default([]),
  stages_openvc: z.array(z.string()).default([]),
  stages_raw: z.string().nullable(),

  // Check size
  check_min_usd: z.number().nullable(),
  check_max_usd: z.number().nullable(),
  check_bands: z.array(z.string()).default([]),
  check_raw: z.string().nullable(),

  // Text
  num_investments_band: z.string().nullable(),
  thesis: z.string().nullable(),
  notes: z.string().nullable(),

  // X/Twitter signal derived from grok_x_lookup. voice_summary is Grok's
  // 2-3 sentence read on how this investor thinks/values, inferred from
  // recent posts. recent_posts is the raw list Grok pulled (newest first).
  x_voice_summary: z.string().nullable().default(null),
  x_recent_posts: z
    .array(
      z.object({
        date: z.string(),
        text: z.string(),
      }),
    )
    .default([]),

  // People associated with the firm (managing partners, GPs, principals, ...).
  // Populated by the extractor from team/about pages. Empty for person-type rows
  // (angel / solo_gp / scout_fund / contact), where person_first/last apply instead.
  // x_* fields are populated on demand via the drawer's per-partner X lookup
  // button, NOT by the orchestrator — they're manual enrichment per person.
  partners: z
    .array(
      z.object({
        name: z.string(),
        title: z.string().nullable().optional(),
        linkedin_url: z.string().nullable().optional(),
        photo_url: z.string().nullable().optional(),
        x_handle: z.string().nullable().optional(),
        x_voice_summary: z.string().nullable().optional(),
        x_recent_posts: z
          .array(z.object({ date: z.string(), text: z.string() }))
          .nullable()
          .optional(),
      }),
    )
    .default([]),

  // Portfolio companies harvested from /portfolio, /companies, /investments pages.
  // `fund` groups them (Fund I / Fund II / "Seed" / "Growth" / null if ungrouped).
  portfolio_companies: z
    .array(
      z.object({
        name: z.string(),
        url: z.string().nullable().optional(),
        fund: z.string().nullable().optional(),
        logo_url: z.string().nullable().optional(),
      }),
    )
    .default([]),

  // Meta
  linked_firm_id: z.number().nullable(),
  completeness_score: z.number().default(0),
  missing_fields: z.array(MissingField).default([]),
  quality_flags: z.array(z.string()).default([]),

  // Enrichment-side audit (filled by orchestrator, not by ingest)
  last_enriched_at: z.string().nullable().default(null),
  total_steps: z.number().default(0),
  tool_budget_cents_used: z.number().default(0),

  // Dead-letter tracking. Each "batch" is one full play-scrape cycle on a
  // row (the client loops runOneStep until terminal). batch_attempts is the
  // cumulative count. zero_progress_streak counts consecutive batches where
  // no field was merged — resets to 0 on any merge. When it crosses
  // DEAD_LETTER_STREAK, scrape_status becomes "dead_letter" and the row is
  // skipped by the candidate pool. last_batch_attempt_at is the ISO timestamp
  // of the most recent bumpBatchAttempt write.
  batch_attempts: z.number().default(0),
  zero_progress_streak: z.number().default(0),
  last_batch_attempt_at: z.string().nullable().default(null),
  // Row-level classifier derived from step history. Refreshed after every
  // step by step-runner. "complete": no missing_fields. "partial": some
  // fields filled, more to go. "dead_site": at least 2 steps ran and zero
  // fields were ever extractable (usually JS-rendered/blocked sites).
  // "error_only": every step errored. "stuck_at_cap": total_steps hit
  // STEP_MAX_PER_ROW with missing fields still unfilled — needs operator
  // intervention (reset, bump cap, or manually mark dead). "dead_letter":
  // zero_progress_streak >= DEAD_LETTER_STREAK — the candidate pool filters
  // these out so repeat-empty profiles stop eating credits. null: untouched.
  scrape_status: z
    .enum([
      "complete",
      "partial",
      "dead_site",
      "error_only",
      "stuck_at_cap",
      "dead_letter",
    ])
    .nullable()
    .default(null),
  // Short 1–3 word label that accompanies scrape_status in the UI — used to
  // surface the specific root cause for error/dead-site rows (e.g. "DNS error",
  // "proxy error", "empty pages") without forcing the user to open step logs.
  scrape_status_reason: z.string().nullable().default(null),
});
export type Row = z.infer<typeof Row>;

// Each Step doc = one orchestrator decision + its tool call + extraction delta.
// Written into /projects/{pid}/rows/{rowId}/steps/{stepId} in sequence.
export const StepStatus = z.enum(["running", "done", "error", "skipped"]);
export type StepStatus = z.infer<typeof StepStatus>;

export const Step = z.object({
  id: z.string(),
  row_id: z.string(),
  project_id: z.string(),
  idx: z.number(),                 // 0, 1, 2, ... per row
  started_at: z.string(),           // ISO
  finished_at: z.string().nullable().default(null),
  // Phase breakdown in milliseconds. Populated by runOneStep; nulls where the
  // phase didn't run (e.g. tool_ms/extract_ms null on stop path, extract_ms
  // null when the tool itself errored).
  timings: z
    .object({
      decide_ms: z.number().nullable().default(null),
      tool_ms: z.number().nullable().default(null),
      extract_ms: z.number().nullable().default(null),
      total_ms: z.number().nullable().default(null),
    })
    .partial()
    .default({}),
  status: StepStatus.default("running"),

  // Decision layer
  decision_model: z.string(),       // e.g. "qwen3.5-plus"
  decision_reasoning: z.string().nullable().default(null),
  chosen_tool: z.string().nullable().default(null),
  chosen_tool_args: z.record(z.string(), z.unknown()).default({}),

  // Tool invocation
  tool_input: z.record(z.string(), z.unknown()).default({}),
  tool_raw_output: z.unknown().nullable().default(null),
  tool_cost_cents: z.number().default(0),

  // Extraction delta
  extracted_fields: z.record(z.string(), z.unknown()).default({}),
  confidence: z.record(z.string(), z.number()).default({}),

  // Per-field reason a proposed extraction was NOT merged into the row.
  // Written by finishStepAndMergeRow. Values include: "confidence_floor",
  // "null_value", "unsourced_overwrite", "anti_truncation",
  // "partners_title_only_upgrade", "budget".
  merge_skip_reasons: z.record(z.string(), z.string()).default({}),

  error_message: z.string().nullable().default(null),

  // Classified error kind from the tool layer (ToolErrorKind plus "invented_url").
  // Lets the UI filter dead_host vs rate_limit vs invented_url without
  // string-sniffing error_message, and lets the orchestrator surface the kind
  // to the next decide() call so it pivots tools instead of retrying.
  error_kind: z.string().nullable().default(null),

  // Free-form structured error context, additive so new kinds don't need
  // a schema migration. Current shapes:
  //   dead_host:    { host: string }
  //   invented_url: { tried_host, allowed_hosts: string[] }
  error_detail: z.record(z.string(), z.unknown()).nullable().default(null),
});
export type Step = z.infer<typeof Step>;

export const Project = z.object({
  id: z.string(),
  name: z.string(),
  created_at: z.string(),
  row_count: z.number().default(0),
});
export type Project = z.infer<typeof Project>;

// Firestore path helpers
export const paths = {
  project: (pid: string) => `projects/${pid}`,
  rows: (pid: string) => `projects/${pid}/rows`,
  row: (pid: string, rowId: string) => `projects/${pid}/rows/${rowId}`,
  steps: (pid: string, rowId: string) => `projects/${pid}/rows/${rowId}/steps`,
  step: (pid: string, rowId: string, stepId: string) =>
    `projects/${pid}/rows/${rowId}/steps/${stepId}`,
  // Global "paused" flag. Single doc so it's cheap to read from every
  // runOneStep invocation and cheap to subscribe to from the dashboard.
  systemState: (pid: string) => `projects/${pid}/system/state`,
} as const;

// Contents of projects/{pid}/system/state. When paused=true, runOneStep
// short-circuits with PreCheckError("system_paused") so /api/step returns
// 409 and the client stops all in-flight scrapes. Operator un-pauses via
// /api/system/unpause once credits are topped up.
export type SystemState = {
  paused: boolean;
  paused_at: string | null;     // ISO; when the switch flipped
  paused_reason: string | null; // short human-readable string, e.g. "apify 402: insufficient credit"
  paused_tool: string | null;   // which tool tripped it
  paused_kind: string | null;   // error_kind that tripped it: "credit" | "auth"
};

export const DEFAULT_PROJECT_ID = "default";
