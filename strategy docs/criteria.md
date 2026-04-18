# The investor-matching framework for Qurio

## Executive summary

Matching startups to investors at scale collapses to **three deal-breaker gates** (stage, sector/business-model thesis, geography) followed by **four strong ranking signals** (check size, lead vs. follow, fund-cycle/activity, portfolio-conflict) and **three tie-breakers** (partner-level fit, founder-profile preference, platform value-add). The single most important design insight from the literature — David Teten and Stéphane Nasser's 161-thesis study, Peter Walker's Carta data, and the stated-vs-revealed-preference problem — is that **public thesis text is unreliable and portfolio behavior is ground truth**. A programmatic matcher should therefore be a two-pass system: cheap scraped fields open a funnel; a Crunchbase-enriched portfolio-revealed-thesis pass closes it. For 5,000 investors, expect 30–40% to explicitly state check size, ~30% to state lead preference, and <20% to state founder preferences — most Tier 2/3 signals must be inferred. Use LLM extraction with structured output (Instructor/BAML) for the scrape, BERTopic or embedding-cosine for thesis inference, and SEC Form D + rolling deal cadence as your killer "is this fund actually writing checks right now" signal.

---

## The criteria framework: ten signals, ranked

### Deal-breakers (hard gates — fail any, eliminate the investor)

**1 · Stage fit.** A Series B fund with a $400M vehicle cannot write you a $250K check; a pre-seed fund cannot lead your $20M Series A. Fund economics make this a hard constraint. Teten's study found **30% of self-labeled "early-stage" VCs don't actually invest pre-revenue** — the label is insufficient; validate against portfolio. Scrape-ability: **Easy–Medium.** Usually in homepage hero, About/Thesis/FAQ, or partner bios. Normalization pain: "pre-seed" in 2018 ≈ "seed" in 2024; "inception," "day-zero," "formation-stage," "first institutional check" all map to pre-seed. Flag multi-stage funds rather than forcing a bucket. **NLP layer:** High value — co-extract stage + check size + lead preference from prose. **Secondary fallback:** Crunchbase (stage filter is a first-class field), PitchBook, Signal NFX self-tags, OpenVC, SEC Form D per round.

**2 · Sector / business-model thesis.** Hull's research (cited by OpenVC): VC returns are materially worse outside a firm's focus area. **Teten: 94% of VCs claim to invest in software — so "software" is not discriminating**; you need finer granularity, e.g. AI-native / applied-AI-SaaS / AI-infra / AI-for-X vertical. Scrape-ability: **Medium, high with NLP.** Sources: Thesis/Focus pages, per-vertical microsites (a16z has separate thesis pages for crypto, bio, fintech, American Dynamism), portfolio tags, partner-authored blog posts. Normalization: "enterprise software" ≈ "SaaS" ≈ "B2B software" ≈ "productivity tools" — build a synonym dictionary. Treat sector and business model as separate fields. **NLP layer:** Essential. Embed thesis text + portfolio one-liners; cosine-similarity to your startup description. **Secondary fallback:** Crunchbase "Portfolio Industries" aggregate, PitchBook verticals (~50), Signal NFX sector rankings, partner Twitter/X and 20VC/Invest-Like-the-Best podcast transcripts.

**3 · Geography (HQ ≠ investment geo).** LP mandates, regulatory regimes (SBIC, EIS/SEIS, SFDR), and board-proximity preferences create legal and practical constraints. Teten: **75% of VCs invest in more than one country**; HQ is not investment scope. Scrape-ability: **Easy for HQ, Medium for investment geo.** HQ in footer/contact; investment scope in Thesis page or inferred from portfolio HQs. Normalization: "EMEA" decomposes to europe+mena+africa; "APAC" to east_asia+sea+anz+south_asia; "North America" sometimes excludes Mexico. **NLP layer:** NER on location entities + validation against portfolio company HQs. **Secondary fallback:** Crunchbase portfolio HQs (empirical geo), OpenVC, Signal NFX geo rankings, Form D (issuer state), LinkedIn partner locations.

### Strong ranking signals (reorder the shortlist)

**4 · Check size / round participation.** OpenVC's "golden filter." NFX: *"Each fund has its own magic number — a sweet spot for ownership and check size that maps to their fund math."* Scrape-ability: **Medium–Hard** (<40% of sites state it explicitly). Inference: **avg_check ≈ fund_size × 0.6 / num_portfolio_companies** (assumes 60% initial / 40% reserves; typical 25–35 portfolio size at seed). Watch for initial-check vs. total-allocated confusion — reserves are often 2–5× the initial check. Store as bands ($0–250K, $250K–$1M, $1M–$3M, $3M–$10M, $10M–$30M, $30M+) plus raw min/max. **Secondary fallback:** Crunchbase round amounts per portfolio investment, SEC Form D (fund size from their own raise), PitchBook "typical check size," Signal NFX.

**5 · Lead vs. follow preference.** Misclassifying a follow-only fund as a potential lead burns weeks. Mercury's guidance: smaller investors (angels, accelerators) almost never lead. Scrape-ability: **Medium.** Sometimes explicit ("we lead seed rounds"); usually inferred from portfolio (who was the named lead on each round the fund participated in?). Inference rule: if `fund_size < $50M` and stage ≥ seed → likely lead; if type ∈ {angel, family_office, rolling_fund} → likely follow. **Secondary fallback:** Crunchbase round-level "lead investor" field (this is the gold source), press releases ("led by X, with participation from Y, Z"), Signal NFX self-reports.

**6 · Fund cycle / active-deployment status.** The most-overlooked filter and the #1 cause of ghosting. Carta data: **2021-vintage funds are 83% deployed; 2017–2020 vintages are ≥89% deployed**. A firm between funds may not write checks at all, regardless of how polished the website is. Only ~50% of pre-2022 US startup investors from the peak are still writing checks in 2024 (PitchBook: unique active investors fell from 25,000 → <12,000). Scrape-ability: **Hard; requires inference.** **Secondary fallback (critical):** SEC EDGAR Form D (every new fund files with fund size — gold standard for "do they have money right now"), Crunchbase last-investment-date and trailing-12-month count, Axios Pro Rata / TechCrunch fund-close announcements, partner LinkedIn "excited to announce Fund V" posts, Carta vintage benchmarks.

**7 · Portfolio conflicts / competitive overlap.** SaaStr (Lemkin): *"Any VC writing $1M+ checks tries to avoid funding directly competitive companies."* For an AI-productivity B2B tool, a firm backing Notion, ClickUp, Linear, or Airtable will pass — often without saying why. Scrape-ability: **Easy for list, Medium for similarity detection.** Almost every firm publishes a portfolio page. **NLP layer:** Embed portco descriptions (pull from Crunchbase or scrape each portco's about page); compute cosine similarity to your startup pitch; flag top-N similar portcos per firm for human review. Accelerators (YC, Techstars, 500) are exempt — they back direct competitors by design and lack information rights. Exited or shut-down portcos lower the conflict weight.

### Tie-breakers (personalization and ranking refinement)

**8 · Partner-level fit.** NFX: *"There is a partner-founder fit... learn what each NFX Partner is interested in by visiting their Signal profiles."* The firm thesis is often too broad; the specific partner who will champion your deal is the decision variable. Scrape-ability: **Medium.** Team pages are ubiquitous but partner-specific thesis lives in LinkedIn posts, Twitter bios, personal Substacks, and podcast appearances. Title matters: GP > Principal > Venture Partner > Scout in deal-decision power. **Secondary fallback:** LinkedIn (most reliable for background), Signal NFX partner profiles, Twitter/X, podcasts (20VC, Invest Like the Best), Crunchbase person records with personal deal history.

**9 · Founder/team profile preferences.** Low-precision when implicit (everyone backs "exceptional founders"), high-signal when explicit (Backstage Capital, Female Founders Fund, HF0, Neo). Scrape-ability: **Medium when stated (~10–20%), harder otherwise — infer from portfolio founder backgrounds via LinkedIn.** Canonical tags: `technical_founder`, `repeat_founder`, `domain_expert`, `academic_spinout`, `ex_faang`, `underrepresented_focus`, `immigrant_focus`. **Secondary fallback:** VC Sheet curated lists, Crunchbase Diversity Spotlight tags, LinkedIn portfolio-founder analysis.

**10 · Value-add / platform capabilities.** Mostly for tie-breaking and outreach personalization, not filtering. Tag into: `recruiting`, `gtm_sales`, `content_pr`, `follow_on_capital`, `network_community`, `technical_help`. Scrape-ability: **Easy** from "Platform" / "How we help" pages but self-reported and aggrandized. **Secondary fallback:** VC Sheet breakdowns, founder references (hard to automate), Twitter/X testimonials from portfolio CEOs.

### Full criterion summary

| # | Criterion | Tier | Scrape-ability | Primary location | Best secondary source |
|---|---|---|---|---|---|
| 1 | Stage fit | Gate | Easy–Medium | Homepage, Thesis, FAQ, partner bios | Crunchbase stage filter, Form D |
| 2 | Sector/BM thesis | Gate | Medium (High w/ NLP) | Thesis page, vertical microsites, portfolio tags | Crunchbase portfolio industries, podcasts |
| 3 | Geography | Gate | Easy (HQ) / Medium (invest) | Footer, Thesis, Team | Crunchbase portfolio HQs, Form D |
| 4 | Check size | Rank | Medium–Hard | Thesis, FAQ, press releases | Crunchbase rounds, Form D (fund size) |
| 5 | Lead vs. follow | Rank | Medium | Thesis, partner bios | Crunchbase "lead investor" per round |
| 6 | Fund cycle / active | Rank | Hard / inference | News, partner LinkedIn | **SEC EDGAR Form D**, Carta benchmarks |
| 7 | Portfolio conflicts | Rank | Easy (list) / Medium (match) | Portfolio page | Crunchbase enrichment, G2/Capterra |
| 8 | Partner-level fit | Personalize | Medium | Team, partner bios | LinkedIn, Twitter, podcasts, Signal NFX |
| 9 | Founder preferences | Personalize | Medium when explicit | Thesis, Mission | Crunchbase Diversity, VC Sheet lists |
| 10 | Value-add | Personalize | Easy–Medium | Platform page | VC Sheet, founder Twitter testimonials |

---

## Recommended taxonomy and schema

The schema below reflects current (2025/2026) de-facto standards: Carta for quantitative benchmarks, PitchBook/Crunchbase for classification breadth, ISO 3166 for geography, and OpenVC's "4 golden filters" for the minimum viable gate set.

### Stage enum (canonical)

```
[pre_seed, seed, seed_plus, series_a, series_b, series_c, series_d, series_e_plus, growth, bridge]
```

Store both `stage_declared` (self-reported) and `stage_derived` (from round size + post-money + age). **2025 Carta medians (US, primary rounds):** pre-seed SAFE $0.5–1M at $7.5–10M cap; seed $4M at **$16M pre / $20–24M post**; Series A **$12M at $47.9–60M pre / $78.7M post** (all-time high); Series B $20–40M at ~$119M pre; Series C $50–75M at $300–500M+. AI valuation premium: **+38% at Series A, +193% at Series E+** — store an `ai_adjusted` flag and benchmark separately. Seed→A step-up compressed from 4.2× (2021) to 2.6× (2025); median seed→A wait 616 days.

### Sector taxonomy — recommended ~40-category canonical

Compress from PitchBook (40 industries × 50+ verticals × 85+ emerging spaces) and Crunchbase (47 groups × ~700 industries). Use a 2-layer schema: `sector_primary[]` (canonical enum) + `sector_tags[]` (free-form, synonym-normalized). Canonical categories cluster into:

- **AI & data:** ai_foundation_models, ai_applications, ai_infrastructure, data_infrastructure
- **Enterprise software:** saas_horizontal, saas_vertical, developer_tools, cybersecurity, devops_cloud, productivity_collaboration
- **Fintech:** fintech_payments, fintech_banking, fintech_lending, fintech_wealth, insurtech, crypto_web3
- **Health & bio:** digital_health, healthtech_provider, biotech_therapeutics, medtech_devices, healthtech_payer_rcm
- **Consumer:** consumer_social, consumer_dtc, marketplaces, creator_economy, gaming, edtech, traveltech, foodtech
- **Industrial/frontier:** climate_energy, climate_industrial, agtech, mobility, robotics, space_aerospace, defense, hardware_deeptech, semiconductors, advanced_manufacturing
- **Real-economy:** proptech, logistics_supply_chain, legaltech, hrtech, govtech, retailtech
- **Meta:** generalist

For Qurio specifically, map to `saas_horizontal` + `productivity_collaboration` + `ai_applications` + thesis tags `spatial_computing, ar_vr, ai_agents, developer_tools` (if dev-adjacent).

### Geography schema

```yaml
hq:
  country: iso_3166_alpha2
  state: string
  metro: enum
investment_geo_focus: [enum]    # ~70% of portfolio
investment_geo_open: [enum]     # demonstrated willingness
geo_legally_restricted: bool
```

Regional enum: `global, north_america, usa, canada, latam, europe, uk_ireland, dach, nordics, cee, mena, israel, africa, sea, south_asia, east_asia, anz` + US metros (`bay_area, nyc_tristate, boston, la_socal, seattle_pnw, austin, miami, dc_metro, remote_us_wide`).

### Check-size bands

```
[under_25k, 25k_100k, 100k_250k, 250k_500k, 500k_1m, 1m_3m, 3m_5m, 5m_10m, 10m_25m, 25m_50m, 50m_100m, 100m_plus]
```

### Fund-size tiers (Samir Kaji / Cendana convention)

```
nano (<$25M) · micro ($25–100M) · small ($100–250M) · mid ($250M–$1B) · large ($1–3B) · mega ($3B+)
```

Typical check-to-fund math: 60% initial / 40% reserves, 25–35 initial investments, avg initial ≈ fund_size × 0.015–0.02.

### Business model enum (~15)

```
[b2b_saas, b2c_subscription, b2c_transactional, marketplace, b2b2c, platform, api_first,
 open_source, plg, hardware, deep_tech, biotech_therapeutic, medical_device, services_enabled,
 usage_based, advertising, transaction_fee, licensing_ip, creator_economy, web3_token]
```

### Lead preference enum

```
[lead_only, lead_preferred, co_lead, follow_only, participate, flexible, unknown]
```

Store both `lead_preference_stated` and `lead_preference_inferred` (from Crunchbase "lead investor" field per round).

### Thesis — semi-structured

Thesis does not enum cleanly. Use: `thesis_raw_text` (scraped verbatim) + `thesis_tags[]` (from a curated ~300-term vocabulary, synonym-normalized) + `thesis_embedding` (vector(1536), e.g. OpenAI `text-embedding-3-large` or Cohere `embed-v4`).

### Full per-investor record (condensed)

```yaml
id, name, website, linkedin, twitter
investor_type: enum   # vc_firm, angel, solo_gp, syndicate, accelerator, studio, family_office, cvc, growth, pe, rolling_fund, scout_fund
fund_size_usd, fund_size_tier, current_fund_number, current_fund_vintage
hq_*, investment_geo_focus[], investment_geo_open[], geo_legally_restricted
stages_invested[], stage_lead_stage
typical_check_{min,max}_usd, typical_check_band, sweet_spot_usd, does_follow_ons
lead_preference, lead_preference_inferred
sector_primary[], sector_tags[], business_model[], thesis_raw_text, thesis_tags[], thesis_embedding
founder_preferences[], diversity_focus[]
# Portfolio-derived (computed, not scraped)
portfolio_company_count, avg_check_inferred_usd
portfolio_{stage,sector,geo}_distribution
last_investment_date, investment_velocity_12mo
partners: [{name, title, linkedin, twitter, focus_areas, portfolio_attribution}]
last_scraped_at, data_confidence_score, source
```

---

## Tiered matching architecture

Given scrape coverage will be uneven, run a three-tier funnel. Tier 1 is cheap and runs on all 5,000 investors; Tier 2 adds Crunchbase enrichment on survivors; Tier 3 uses expensive secondary sources only on the top ~100–300 candidates.

### Tier 1 — hard gate (all 5,000 investors, cheap signals)

**Criteria:** stage_fit, sector_primary_overlap (coarse), geography (HQ + stated investment scope), investor_type (exclude PE/debt/public-only), obvious liveness (site exists, last-updated recent, portfolio page has companies founded in last 24 months).

**Extraction:** Single LLM pass per site with Firecrawl for rendering + Instructor/BAML for structured output. Feed in the Homepage + About/Thesis + Team + Portfolio HTML concatenated. One JSON out. Cost per site: ~$0.01–0.03 with GPT-4o-mini or Claude Haiku 4.

**Output:** binary pass/fail against your startup's (stage, sector, geo). Expect roughly **15–25% of investors to pass** the Tier 1 gate for a B2B AI SaaS at seed raising in the US.

### Tier 2 — ranking layer (survivors ~1,000–1,500, medium cost)

**Criteria:** check_size (extracted + inferred from fund size ÷ portfolio count), lead_preference (extracted + inferred from Crunchbase lead attribution), portfolio_conflicts (embed portco descriptions, cosine vs. your pitch, flag top-3 similar per firm), fund_cycle (SEC Form D lookup + Crunchbase trailing-12-month investment count + velocity), sector_thesis_match_semantic (thesis-text embedding cosine + portfolio-revealed thesis from BERTopic clusters).

**Enrichment:** Crunchbase API (or scraping) is the single highest-ROI secondary source — gives you portfolio, rounds, lead attribution, industries, geographies in one pull. SEC EDGAR Form D is free and authoritative for fund cycle. Calculate a scalar fit score with weighted components; produce a ranked top 100–300.

### Tier 3 — deep signal for shortlisted candidates only (~100–300 investors, expensive)

**Criteria:** partner-level fit (which partner to target), founder-profile preferences, value-add specificity, recent partner public signals (last 30 days), warm-intro graph overlap.

**Sources per criterion:**
- **Partner-level thesis** → LinkedIn profile scrape, Twitter/X timeline (last 6 months), podcast appearances (index 20VC, Acquired, Invest Like the Best transcripts), Substack/Medium personal blogs
- **Recent portfolio adds (proxy for active thesis)** → Crunchbase per-person deal history, press releases, Form D per-round filings
- **Warm-intro paths** → Gmail/LinkedIn OAuth against founder's graph (Signal NFX model; this is the single most-praised feature across tool reviews)
- **Investor behavior / quality signals** → crowd-sourced reviews (Foundersuite "Glassdoor for VCs"), Twitter scraping for founder testimonials
- **Dry powder / fund status** → Form D recency, PitchBook if accessible, fund-close news search

This is also where you shift from filter to personalization: Tier 3 output drives outreach copy (reference partner's recent blog post, co-investor pattern, specific portco relevance).

---

## Practical scraping and inference tips

### Scrape-ability reality check

Based on the corpus of VC sites: **portfolio pages exist on >90%**, **thesis statements on ~70% (often vague — "great founders, large markets")**, **explicit stage on ~50%**, **explicit check size on <40%**, **explicit lead preference on ~30–40%**, **explicit founder preferences on ~10–20%**. Common failure modes: JS-rendered Wix/Squarespace layouts (use Playwright/Firecrawl, not requests+BS4), Cloudflare challenges (need residential proxies via Bright Data/ScrapFly), PDF-only fund decks, portfolios shown as logo grids with image alt-text missing, stale portfolios (last-added company 2+ years ago — flag for fund-cycle risk), solo-GP sites with thesis only in a pinned Twitter thread.

**Tiering your 5,000 by layout complexity:** Tier 1 firms (a16z, Sequoia, Accel, etc.) usually have structured portfolio grids with sector tags — easy to parse but JS-heavy. Seed funds (First Round, Floodgate, Homebrew) vary widely; many are Webflow with fairly clean HTML. Solo GPs and emerging managers are the hardest tier: often Notion-hosted, single-page, or just a Twitter bio pointing to an AngelList syndicate. For these, skip scraping and go directly to AngelList/OpenVC/Signal NFX as primary sources.

### Extraction stack recommendation

- **Rendering:** Firecrawl (AI-resilient) as default, Playwright fallback for JS-heavy sites, plain fetch+BS4 for simple static pages. Expect layout churn — AI-described extraction (Firecrawl + LLM) survives redesigns better than CSS-selector scrapers.
- **Structured output:** [Instructor](https://github.com/567-labs/instructor) (Pydantic + LLM function calling, most popular), [BAML](https://github.com/BoundaryML/baml) (schema-first DSL, better for complex nested extraction and cross-language), or [Outlines](https://github.com/outlines-dev/outlines) (constrained decoding for local models).
- **Proxies:** Bright Data or ScrapFly; budget ~$0.001–0.005 per page.
- **Anti-block hygiene:** 2–5 second random delays, User-Agent rotation, respect robots.txt for politeness (investors who see scraper logs will blacklist; scraping the whole firm's traffic is a bad look when you later email them).

### LLM extraction prompt template (single-pass, all criteria)

Feed concatenated HTML of `/`, `/about`, `/team`, `/portfolio`, `/thesis` (up to ~30K tokens after stripping nav/footer/scripts):

```
You are extracting a structured profile of a VC firm from its website HTML.
Return ONLY JSON matching this schema (unknown fields → null, not guessed):

{
  "firm_name": str,
  "investor_type": enum[...],
  "hq": {country, city},
  "fund_size_usd": int | null,
  "current_fund_vintage": int | null,
  "stages_invested": [enum],
  "stage_evidence_quotes": [str],            # verbatim snippets that support the stage list
  "typical_check_min_usd": int | null,
  "typical_check_max_usd": int | null,
  "check_size_evidence_quotes": [str],
  "lead_preference": enum[...],
  "lead_preference_evidence": str | null,
  "investment_geo_focus": [enum],
  "sectors_primary": [enum from fixed list],
  "thesis_summary": str,                     # 2-3 sentence extractive summary
  "thesis_raw_text": str,                    # verbatim thesis paragraph if present
  "exclusions": [str],                       # "we don't invest in: X, Y"
  "founder_preferences": [enum],
  "partners": [{name, title, linkedin_url, twitter_url, focus_quote}],
  "portfolio_company_names": [str],          # extract all visible
  "last_portfolio_update_signal": str | null
}

Rules:
- Never guess. If the site says "early stage" without defining, use ["seed","series_a"] AND set stage_evidence_quotes.
- Preserve verbatim quotes for anything contested (stage, check, lead).
- Empty list, not null, when a field is absent but schema expects array.
```

This one call extracts ~80% of Tier 1 + Tier 2 criteria. Validate against portfolio: re-query Crunchbase for each named portfolio company, aggregate their stages/sectors/geos, and cross-check against stated values. When they conflict (Teten: ~30% of cases), trust the portfolio.

### Thesis inference from portfolio (when text is vague)

Three proven techniques, ranked by cost/value:

- **LLM embedding + cosine.** Embed each portco's one-liner description (Crunchbase or scraped) with `text-embedding-3-large`; take the centroid of a firm's portfolio as their "revealed thesis vector." Embed your startup pitch the same way; rank firms by cosine similarity. Cheap, no labels needed, good baseline. Weight recent investments 2–3× (thesis drift is real).
- **BERTopic on portfolio descriptions.** sentence-transformers → UMAP → HDBSCAN → c-TF-IDF. Output: topic-distribution vector per firm. Better for discovering emergent themes (e.g., a cluster of "AI-native knowledge workers" firms you didn't know to look for). Use supervised mode if you have a seed taxonomy (a16z focus areas are public).
- **Graph + text joint embedding.** Node2Vec on the bipartite investor↔company graph concatenated with BERT embeddings of company descriptions. Recent arXiv work (2511.23364 "Predicting Startup-VC Fund Matches") shows this beats pure text; worth trying if you want signal beyond thesis overlap (co-investor patterns, stage cadence).

### Check-size inference formula

```
avg_initial_check ≈ fund_size × 0.55 / target_portfolio_size
```

Default `target_portfolio_size = 30` at seed, `25` at Series A, `20` at Series B. Cross-validate against Crunchbase portfolio count if available. For firms with multiple active funds, use the most recent vintage.

### Fund-cycle detection (the killer signal)

Compute a scalar `active_deployment_score` per firm:

1. **Form D recency.** New fund filed in last 24 months → +0.4; filed 24–48 months ago → +0.2; >48 months → 0.
2. **Trailing-12-month investment count (Crunchbase).** ≥5 deals → +0.3; 2–4 → +0.15; ≤1 → 0 (and flag).
3. **Deployment-pace trend.** Last 4 quarters vs. prior 4 quarters of investment count; positive slope → +0.2, flat → +0.1, negative → 0.
4. **Partner departures.** Scrape team page diffs over 12 months; ≥1 GP departure without replacement → −0.2.
5. **Fund announcement signal.** LinkedIn/news mention of "Fund N" in last 12 months → +0.2.

Score <0.3 = likely zombie or harvest mode, deprioritize. Carta benchmark: 2021 vintage is 83% deployed, 2017–2020 vintages ≥89% — a seed fund from 2020 without a Fund II announcement is almost certainly not writing checks.

---

## Known gotchas and failure modes

**Stated vs. revealed thesis.** The Teten/Nasser finding is the single most important: 30% of "early-stage" funds don't actually do pre-revenue. Detection: compare `stages_invested` to Crunchbase portfolio round-type distribution; flag drift >30%. Apply same logic to geography ("global" funds with 95% US portfolios) and sector.

**Stage drift upmarket.** Seed funds that raised larger vehicles (2024–2025 trend) now write $3–5M minimums; Crunchbase: seed rounds >$5M are now the majority of seed dollars. A fund whose Fund I wrote $500K–$1M checks in 2020 may be writing $5M checks in 2026 from Fund III. Always re-derive check size from the **most recent fund vintage**, not historical averages.

**Survivorship in portfolio pages.** OpenVC: *"VCs bury their dead quietly; they write medium posts when things went well."* Portfolio pages overrepresent winners. Counter: cross-reference with Crunchbase for full history including shut-downs and exits. Treat the scraped portfolio as a marketing artifact, not a dataset.

**Zombie funds and between-funds silence.** PitchBook: **unique active US startup investors fell from >25,000 (2021) to <12,000 (2024)**, a 50%+ contraction. By end-2018, one-third of seed micro-VCs failed to raise Fund II. Many sites still look polished and current. Detect via the deployment-score formula above.

**Partner vs. fund preferences.** NFX: partner-founder fit matters more than firm-founder fit. Scrape team pages → enrich each partner via LinkedIn + Twitter + podcasts → maintain partner-level thesis separate from firm-level. When a partner leaves, mark their attributed portcos as "legacy," not "active thesis signal."

**The AI-washing problem.** Carta (Peter Walker): **>1 in 3 VC dollars globally now goes to AI companies**. Almost every firm's homepage mentions AI. "We invest in AI" is no longer discriminating. For Qurio, differentiate **AI-native** investors (Conviction, Radical, Felicis, Menlo's AI unit, SV Angel, Andreessen's Infra, Lightspeed's AI practice) from generalists who added "AI" to their homepage in 2023. Signal: AI portfolio concentration in last 12 months, partner background in ML/research, published technical writing about AI (not just pitch-level mentions).

**Anti-thematic funds.** Teten's 8th category: Founder Collective, First Round, Homebrew are deliberately non-thematic. They will score badly on sector-embedding similarity but may still be excellent targets. Maintain a `thesis_style` flag (`thematic` vs. `generalist` vs. `opportunistic`) so these aren't unfairly eliminated.

**Conflict detection false positives.** Exited portcos (acquired, shut down) still appear on portfolio pages. Secondary sales have muddied "active portfolio" definitions. Weight conflict similarity by (a) portco still operating, (b) investment <5 years old, (c) fund has information rights (not just accelerator exposure). YC, Techstars, SV Angel, 500 Global are exempt from the conflict filter.

**Solo GP vs. fund dynamics.** Solo GPs (Elad Gil, Lenny Rachitsky, Harry Stebbings, Cindy Bi) operate very differently from institutional funds — faster decisions, no IC, smaller checks, more willing to back unconventional founders. Model as a separate `investor_type` with different scoring weights (weight fund-cycle lower, partner-thesis higher).

**The "we invest in great founders" non-signal.** ~40% of fund thesis pages contain no discriminating information. Don't penalize these in Tier 1 (they'll fail the sector gate for legitimate reasons anyway); instead fall through to portfolio-revealed thesis in Tier 2.

**Data freshness decay.** B2B data decays ~22.5% per year. Many investor databases are >12 months stale. Re-scrape and re-score quarterly; store `last_verified_at` per field (not per record) so you can weight old data down selectively.

**Legal and ethical.** Public portfolio/thesis/team data is low-risk. Scraping personal partner data raises GDPR concerns in the EU — use LinkedIn's public API fields only, don't aggregate personal contact info. If you productize this, respect robots.txt aggressively (the VCs are your future users and reading scraper logs).

---

## Conclusion

The literature and tool landscape converge on a clear design: **three hard gates, four ranking signals, three personalization signals, with portfolio behavior as the ground truth for every scraped claim.** The technical stack is now cheap enough (Firecrawl + GPT-4o-mini + Crunchbase API + Form D) to do this well at 5,000-investor scale for <$500 in compute per full refresh. The hard problems are no longer extraction but **validation against revealed behavior** and **fund-cycle detection** — the fact that half of 2021's active investors aren't writing checks today makes "is this fund alive right now?" more valuable than any thesis match. For Qurio specifically, your biggest filter will be portfolio conflicts (AI productivity is crowded — Notion, ClickUp, Linear, Glean, Mem.ai, and their adjacencies are already well-funded) and the discriminator between AI-native investors and AI-washed generalists. Ship Tier 1 first, validate gate quality on a hand-labeled set of 100 investors you know the right answer for, then layer Tier 2 enrichment before spending a dollar on Tier 3. The productized version's differentiation, if you pursue one, is the combination nobody has shipped: OpenVC's verified/opt-in data + Signal NFX's Gmail warm-intro graph + Harmonic-style NL search + **partner-level routing** + **active-deployment score** visible on every card.