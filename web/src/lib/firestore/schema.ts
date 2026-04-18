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

  // Meta
  linked_firm_id: z.number().nullable(),
  completeness_score: z.number().default(0),
  missing_fields: z.array(MissingField).default([]),
  quality_flags: z.array(z.string()).default([]),

  // Enrichment-side audit (filled by orchestrator, not by ingest)
  last_enriched_at: z.string().nullable().default(null),
  total_steps: z.number().default(0),
  tool_budget_cents_used: z.number().default(0),
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

  error_message: z.string().nullable().default(null),
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
} as const;

export const DEFAULT_PROJECT_ID = "default";
