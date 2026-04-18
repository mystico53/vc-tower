# PR #2 — Orchestrator with Qwen 3.5 Plus tool-calling

Goal: ship a **per-row step debugger**. Click "Step" on a row → Qwen picks the
next tool → tool runs → extraction fills missing fields → step doc streams live
into the UI. No batch runner yet.

## Scope

### In-scope

- Qwen 3.5 Plus as orchestrator + extractor (DashScope SG endpoint, OpenAI-compatible)
- Three enrichment tools:
  - **Firecrawl** — firm website → LLM-friendly markdown
  - **Apify LinkedIn Profile/Company scraper** — person or firm LinkedIn
  - **xAI Grok 4.1 Fast** with `x_search` tool — X bio + recent topics
- Decision loop fills the fields tracked by `missing_fields` on the masterlist:
  `stages, sectors, check_range, thesis, any_contact, geo`
- Per-row "Step" button advances exactly one decision + its tool call + its
  extraction delta
- Step log subcollection streamed to UI via `onSnapshot`
- Per-row budget guard: max 5 steps, max 10¢ in tool fees (configurable)
- Admin SDK writes only — client never mutates Firestore directly

### Out of scope (deferred)

- Batch / auto-run across many rows (PR #3 via Cloud Tasks)
- Crunchbase enrichment (needs paid API; strategy's highest-ROI later)
- SEC Form D fund-cycle signal
- Embedding-based thesis similarity
- Partner-level enrichment for VC firms
- Retry / backoff queue semantics (v1 = best-effort, errors surface in UI)

## Architecture

```
┌─ UI (client) ────────────────────────────────┐
│  RowTable                                     │
│   └─ row click → RowDrawer                    │
│        ├─ Step button  POST /api/step         │
│        └─ StepLog  onSnapshot steps/          │
└─ ────────────────────────────────────────────┘
                │
                ▼
┌─ /api/step (Next route handler, nodejs) ─────┐
│  1. auth: verify Firebase ID token            │
│  2. load row + prior steps                    │
│  3. call orchestrator → pick next tool        │
│  4. execute tool → raw output                 │
│  5. call extractor → structured fields        │
│  6. merge delta into row                      │
│  7. write Step doc + update Row               │
└─ ────────────────────────────────────────────┘
                │
                ▼
    ┌── tools ──┬─────────┬──────────────┐
    │ Firecrawl │ Apify   │ Grok x_search│
    │ (website) │(LI page)│ (X timeline) │
    └───────────┴─────────┴──────────────┘
```

## Model + API surface

| Concern | Choice | Rationale |
|---|---|---|
| Orchestrator + extractor | **Qwen 3.5 Plus** via DashScope SG OpenAI-compat | $0.26/$1.56 per 1M tokens; top Chinese model for tool-calling (96.5% BFCL-style); 1M ctx |
| Decision strategy | Single-shot tool-calling per step (structured JSON) | One LLM call → one tool choice. Simpler than multi-turn agent loops for debug mode. |
| Extraction strategy | Second LLM call per step with Zod JSON schema | Validated output; re-prompt on schema failure (max 1 retry). |
| Client library | `openai` npm (OpenAI-compatible with DashScope base URL) | Zero custom SDK work |

### Env vars (add to `.env.example` + `.env.local`)

```
DASHSCOPE_API_KEY=
DASHSCOPE_BASE_URL=https://dashscope-intl.aliyuncs.com/compatible-mode/v1
DASHSCOPE_MODEL=qwen-plus-2025-09-11   # pin exact snapshot, not alias
FIRECRAWL_API_KEY=
APIFY_TOKEN=
APIFY_LINKEDIN_PROFILE_ACTOR=supreme_coder/linkedin-profile-scraper
APIFY_LINKEDIN_COMPANY_ACTOR=data-slayer/linkedin-company-scraper
XAI_API_KEY=
XAI_MODEL=grok-4-1-fast
STEP_MAX_PER_ROW=5
STEP_BUDGET_CENTS_PER_ROW=10
```

## Orchestrator contract

### Input to orchestrator

```json
{
  "row": {
    "name": "...",
    "firm_name": "...",
    "investor_type": "vc_firm | angel | ...",
    "website": "... | null",
    "linkedin": "... | null",
    "twitter": "... | null",
    "email": "... | null"
  },
  "missing_fields": ["stages", "sectors", "thesis"],
  "steps_taken": [
    { "tool": "firecrawl_website", "status": "done", "filled": ["geo"] }
  ],
  "budget_cents_remaining": 8
}
```

### Output from orchestrator

```json
{
  "reasoning": "Missing thesis/stages/sectors; website was scraped but LinkedIn not tried yet. Firm-type row → use linkedin_company_scraper.",
  "next_action": "tool" | "stop",
  "tool": "linkedin_company",
  "tool_args": { "url": "https://linkedin.com/company/example" },
  "stop_reason": null | "all_filled" | "budget" | "no_useful_tools"
}
```

Orchestrator may choose `stop` even if fields remain missing — e.g. no
identifiers available for the remaining tools.

## Tool contracts

Every tool is a TS function `(args) => ToolResult`:

```ts
type ToolResult = {
  ok: boolean;
  cost_cents: number;
  raw: unknown;         // full provider response (stored in step doc)
  markdown?: string;    // for Firecrawl
  error?: string;
};
```

### 1. Firecrawl (`firecrawl_website`)

- **Args:** `{ url: string }`
- **Impl:** POST to Firecrawl `/v2/scrape` with `formats: ["markdown"]`
- **Cost:** 1¢ per successful page (rough)
- **Fallback:** if Firecrawl 429/fails, try **Jina Reader** (`r.jina.ai/{url}`)
  as free fallback. Flag on the step doc which source was used.

### 2. Apify LinkedIn (`linkedin_profile` | `linkedin_company`)

- **Args:** `{ url: string }`
- **Impl:** `POST /v2/acts/{actorId}/run-sync-get-dataset-items?token=...`
  (sync variant returns results directly; run-time 10–30s)
- **Cost:** ~0.3¢ per LinkedIn profile ($3/1k)
- **Error policy:** Apify returns `ok:false` → skip this tool for this row

### 3. Grok x_search (`grok_x_lookup`)

- **Args:** `{ name: string, firm?: string, handle?: string }`
- **Impl:** `POST https://api.x.ai/v1/chat/completions` with:
  ```
  tools: [{ type: "x_search", x_search: { ... } }]
  ```
  - If `handle` known → pass `allowed_x_handles: [handle]`
  - If unknown → let Grok do user-search itself (2–3 internal tool calls)
  - `from_date`: 6 months ago in `YYYY-MM-DD`
- **Prompt:** "Return JSON `{handle, bio, active, recent_topics[], thesis_clues[]}`"
- **Cost:** ~$0.005–0.015 per row (1–3 tool invocations + tokens)
- **Note:** xAI Live Search API deprecates 2026-01-12 — use the new
  function-calling `x_search` from day one.

## Extraction contract

After a tool runs, the extractor LLM call takes:

- The tool's raw output (markdown, LinkedIn JSON, or Grok JSON)
- The current `missing_fields` list
- The row's existing values (so the extractor doesn't contradict known data)

It returns a **field-by-field delta**:

```json
{
  "stages": {
    "value": ["seed", "series_a"],
    "confidence": 0.9,
    "evidence_quote": "we lead seed and Series A rounds"
  },
  "sectors_l1": {
    "value": ["AI_ML", "SaaS"],
    "confidence": 0.8,
    "evidence_quote": "AI-native vertical SaaS"
  },
  "thesis": {
    "value": "We invest in early-stage AI applications...",
    "confidence": 0.95,
    "evidence_quote": null
  }
}
```

Rules (pass to extractor as system prompt):

- Never guess. If a field isn't explicitly supported by evidence, omit it.
- Map sectors to `CANONICAL_SECTORS_L1` from `scripts/build_masterlist.py`.
- Map stages to `CanonicalStage` enum.
- Preserve verbatim quotes for stage, check, lead (matches strategy doc).
- Confidence is the extractor's self-report, not calibrated. Below 0.5 → drop.

## Firestore writes per step

One step = one atomic batch:

1. Create `/projects/{pid}/rows/{rid}/steps/{stepId}` doc with full step record
   (reasoning, tool, tool_args, raw output, extracted fields, confidence, cost)
2. Update `/projects/{pid}/rows/{rid}`:
   - merge fields where `confidence >= 0.5`
   - recompute `missing_fields`
   - increment `total_steps`, `tool_budget_cents_used`
   - update `last_enriched_at`

`stepId` = zero-padded index (`000`, `001`, ...) so ordering is lexicographic
and the UI doesn't need to sort numerically.

## UI additions

### Row drawer (new)

Click a row in the table → right-side drawer with:

- Top: the row's current values by field group (identity, geo, thesis, money)
- Missing-field pills (same component as the table cell)
- **"Step" button** — POSTs `/api/step` with `{ rowId }`, disabled while
  a step is in-flight for this row
- **Step log** — scroll-area with one card per step showing:
  - Timestamp + tool badge + status (running/done/error/skipped)
  - Reasoning from orchestrator (collapsed, expandable)
  - Tool args (collapsed)
  - Extracted delta: list of fields filled with confidence bars
  - Raw output: collapsed JSON viewer (expandable for debugging)
  - Cost in cents

Step log subscribes to `rows/{rid}/steps` ordered by `idx`.

### Budget indicator

Small meter at the top of the drawer: `x / 5 steps · y¢ / 10¢ used`.
When either cap is hit, "Step" disables with tooltip "Budget exceeded —
reset to re-run." (Reset path = dev-only button that wipes step log and
audit counters for that row.)

## Code layout

```
web/src/
├─ lib/
│  ├─ orchestrator/
│  │  ├─ decide.ts           # calls Qwen → picks next tool
│  │  ├─ extract.ts          # calls Qwen → extracts structured fields
│  │  └─ prompts.ts          # system prompts (kept out of code for easy tuning)
│  ├─ tools/
│  │  ├─ firecrawl.ts
│  │  ├─ jina.ts             # fallback when firecrawl 429s
│  │  ├─ apify-linkedin.ts
│  │  └─ grok-x-search.ts
│  └─ firestore/
│     └─ step-writer.ts      # atomic (row update + step doc) write
├─ app/
│  └─ api/
│     └─ step/
│        └─ route.ts         # POST { rowId } → runs one decision
└─ components/
   ├─ row-drawer.tsx
   ├─ step-log.tsx
   └─ step-card.tsx
```

## Error handling (v1, minimal)

- Tool throws / returns `ok:false` → step doc written with `status: "error"`,
  no fields merged, counters still increment (so repeated failures hit the
  5-step cap).
- Orchestrator returns invalid JSON twice → write a step doc with
  `status: "error"`, `error_message: "orchestrator parse failed"`, stop.
- Extractor returns invalid JSON → retry once; if still bad, merge nothing
  but record the raw tool output on the step doc (debuggable in UI).
- Any budget cap hit → step doc `status: "skipped"`, `error_message: "budget"`.

## Testing

- **Manual smoke test:** pick 5 rows across investor_types (vc_firm, angel,
  solo_gp, accelerator, contact), step each to completion, eyeball the
  step log for: correct tool sequencing, non-hallucinated extraction,
  evidence quotes that actually appear in the tool output.
- **Unit tests** (minimal v1): extractor schema validation with 2 golden
  Firecrawl markdown fixtures; orchestrator decision on a hand-built row.
- **No e2e / integration tests** in PR #2 — the debug UI is itself the
  integration harness.

## Open questions to resolve before shipping PR #2

1. **Qwen model name to pin.** DashScope offers `qwen-plus` (alias, floats)
   and dated snapshots like `qwen-plus-2025-09-11`. Pin the snapshot so
   behavior doesn't silently drift. Confirm availability on the SG endpoint.
2. **Firecrawl concurrency.** Free tier is 10 concurrent reqs. Single-step
   mode won't hit this; batch will. Note for PR #3.
3. **LinkedIn URL discovery.** If row has no `linkedin`, do we (a) search via
   Google/Bing first, (b) let Grok find it and pass back, or (c) skip? For v1
   I'd pick (c) — only scrape LinkedIn when URL is already in the row.
4. **X handle discovery.** Same as LinkedIn — for v1, only call Grok when
   `twitter` is already in the row, or when we have both `name` + `firm`
   (Grok can resolve itself in that case at ~$0.01 extra).
5. **Where do updates to `thesis`, `sectors`, etc. surface for the user to
   accept/reject?** Strict auto-apply for v1 (confidence ≥ 0.5 merges);
   accept/reject UI would be nice but adds complexity. Ship auto-apply first.
6. **Reset button.** Dev-only or user-facing? Recommend dev-only, gated by
   `?dev=1` query param for now.

## Rollout order inside PR #2

1. Env vars + `.env.example` update, type-safe env access helper
2. Firecrawl tool + test fixture
3. Extractor with Zod schemas for each field group
4. Orchestrator decide.ts with tool catalog
5. `/api/step` route handler (auth verify, orchestrator call, tool call,
   extractor call, Firestore write)
6. RowDrawer + StepLog UI components
7. Wire "Step" button into RowTable (row click opens drawer)
8. Apify + Grok tool adapters (can ship in 2a if Firecrawl + extractor work end-to-end)

Target: end-to-end "click Step, see field fill in" in ~2 focused days.
