# Building a programmatic investor-matching system: criteria, taxonomies, and scrape-ability

**Eight criteria drive nearly every serious startup–investor matching system, and only four of them are reliably extractable from VC websites at scale.** The rest require portfolio-pattern inference, SEC Form D enrichment, or Crunchbase-style external data. This matters because a naïve scraper that tries to parse "check size" and "thesis" directly from fund websites will produce garbage for 60–85% of the 5,000 targets — but a layered system that extracts what's easy, infers what's fuzzy, and enriches what's missing will yield usable matches for ~80% of investors. The research synthesized below — from Signal NFX, OpenVC, Harmonic, PitchBook, Crunchbase, Carta, a16z, YC/PG, Elad Gil, Mark Suster, Jason Lemkin, and First Round — converges on a surprisingly consistent schema. The founder-advice hierarchy also inverts what matching platforms optimize for: platforms sort on stage, sector, and geography because they're extractable, but senior founder voices rank **trust in the specific partner** and **follow-on/support behavior** as the actual drivers of good outcomes. Your system should filter on what's scrapeable, but rank with signals that approximate what actually matters.

## The eight criteria that matter, ranked by scrape-ability

Across OpenVC, Signal NFX, Harmonic, PitchBook, Crunchbase, VCSheet, Visible Connect, and Foundersuite, four filters appear on **every single platform**: stage, sector, geography, and investor type. Check size appears on 7 of 8. Thesis, lead/follow, and portfolio appear on 6 of 8. Everything else is platform-specific differentiation. These are the irreducible core.

Below, each criterion is rated for scrape-ability on a four-point scale (**easy** = parse static HTML; **medium** = needs JS rendering or prose parsing; **hard** = rarely stated, needs regex + enrichment; **inference** = must be derived from portfolio patterns or third-party sources). Realistic yield percentages assume a pool of 5,000 investors spanning top-tier funds, mid-tier seed funds, solo GPs, and angels.

### 1. Stage focus — medium scrape-ability, ~80% yield after inference

**Why it matters:** The single most common deal-breaker. A $2B multi-stage fund writing $15M minimum checks cannot participate in a $1.5M pre-seed round. NFX, Suster, and Lemkin all cite stage mismatch as the first disqualifier — even Mike Maples (Floodgate) openly tells founders "if you're raising a $10M Series A, we are not going to be the right partner. This is an easy pass."

**Where it lives on sites:** `/about`, `/approach`, and homepage hero text contain stated stages on roughly **45% of sites**. Phrases like "we lead seed and Series A rounds" or nav labels like "Seed" and "Early Stage" are common on Webflow-templated sites. Portfolio pages rarely tag rounds directly (~10–15%).

**Normalization challenges:** Stage labels are a mess. "Seed" means $500K at one fund and $5M at another. Carta reports that **40%+ of recent seed and Series A activity are bridge rounds**, a sub-classification Crunchbase doesn't even enumerate. Best practice: store both a label (`pre_seed | seed | seed_extension | bridge_seed | series_a | ...`) and **Crunchbase's numeric breakpoints — <$3M = seed/angel bucket, $3M–$15M = early, >$15M = late** — so you can bucket machine-readably when the label is ambiguous.

**NLP extension:** High-value. A simple regex for stage keywords plus an LLM structured-output call on `/about` prose resolves ~80% of cases. When absent, infer from the investor's portfolio: pull portfolio companies, look up their last funding round on Crunchbase, take the mode. If >60% of their portfolio entered at seed, they're a seed fund.

### 2. Sector / industry focus — medium, ~85% after inference

**Why it matters:** Second most common deal-breaker. Thesis-driven funds (USV on networks, NFX on network effects, Bessemer on cloud) will pass reflexively on off-thesis deals.

**Where it lives:** Stated sector focus on ~55% of sites — nav labels, `/thesis`, home-hero taglines. **a16z is the gold standard**: dedicated subdomains like `/ai`, `/bio-health`, `/american-dynamism`, `/fintech`, each with thesis + team + portfolio slice. Portfolio logo grids on ~85% of sites are the richer signal — extract company names, cross-reference Crunchbase categories, and aggregate the distribution.

**Normalization challenges:** **Use a hierarchical schema**. PitchBook uses three layers — Industries (8 top-level) → Verticals (50+, analyst-curated like "AI & ML," "ClimateTech," "Cybersecurity") → Emerging Spaces (85+, e.g., "agentic AI," "humanoid robotics"). Crunchbase uses ~46 Industry Groups containing ~700 Industries; note that Software alone captures ~38% of Crunchbase companies — you must go deeper than L1. NAICS/SIC codes are **not used in VC matching** and should be ignored unless you're cross-referencing government data.

**Recommended schema:**
```
sector_l1: enum [AI_ML, SaaS, FinTech, HealthTech, BioTech, ClimateTech,
                 Consumer, Marketplace, DevTools, Cybersecurity, DeepTech,
                 Hardware, Robotics, PropTech, EdTech, Gaming, Defense,
                 Crypto_Web3, Space, AgTech, FoodTech, Other]
sector_l2: controlled vocab (~300 tags)  // e.g. "AI_Infrastructure", "Vertical_SaaS_Construction"
pitchbook_verticals[]: optional mapping for interop
```

**NLP extension:** Very high-value. Thesis embeddings (OpenAI `text-embedding-3-large`) over each fund's `/about` + blog content enable soft cosine-similarity ranking for startups whose sector sits between categories (e.g., "AI × construction" maps to both AI and PropTech funds).

### 3. Geographic focus — medium, ~90% yield

**Why it matters:** Many funds are geographically constrained by LP mandate, tax structure, or local-network value-add. A Colorado-only fund will pass on a Brussels startup regardless of stage-fit.

**Where it lives:** Footer addresses, `/about` text ("we invest in Europe and Israel"), and portfolio company geographies (inferable). Three common patterns: **global** (Sequoia, a16z, Tiger), **regional** ("US & Canada," "SEA"), **city-specific** ("NYC only," "Colorado Front Range").

**Normalization challenges:** HQ of fund ≠ investment geography. Harmonic uniquely separates **founder location from company HQ** (surfacing Bay Area companies with remote founders). OpenVC splits company-geography and investor-HQ as two fields. Your schema should too:

```
investor_geography:
  scope_type: enum [global, multi_region, regional, country, metro_only]
  countries[]: ISO-3166
  regions[]: enum [US_West, US_Northeast, Europe_Western, Europe_Nordics,
                   Israel, SEA, India, LatAm, MENA, Africa, ...]
  metros[]: controlled vocab (SF_Bay, NYC, London, Berlin, Tel_Aviv, ...)
```

**NLP extension:** Modest. Geography parsing is mostly regex + NER. First Round's 10-year data suggests founders **overweight geography** — companies outside SF/NYC actually performed 1.3% better — so don't over-penalize distant matches.

### 4. Investor type — easy, ~95% yield

**Why it matters:** Angels, micro-VCs, seed funds, multi-stage funds, CVCs, family offices, accelerators, studios, and syndicates behave fundamentally differently. CVCs bring strategic value but slower decisions; accelerators write small program checks; family offices have longer horizons. Foundersuite and PitchBook use 10+ type categories.

**Where it lives:** Usually obvious from the site name, footer ("Acme Ventures LLC"), and structure. Solo GPs are obvious (single bio, first-person prose). Accelerators have program language.

**Normalization schema:**
```
investor_type: enum [angel, angel_group, solo_gp, micro_vc, seed_fund,
                     multi_stage_vc, growth_equity, crossover, cvc,
                     family_office, accelerator, incubator, studio,
                     syndicate, sovereign_fund, pe_firm]
```

**NLP extension:** Minimal needed — a simple classifier over the landing page hits ~95% accuracy.

### 5. Check size and fund size — hard, ~70% yield with enrichment

**Why it matters:** The precision filter after stage. A "seed fund" could mean $250K checks or $4M checks. Lemkin puts "bigger checkbook" in his top 6 picks criteria because follow-on capacity is critical.

**Where it lives:** Only ~15% of fund websites state check size explicitly (examples that do: Bonfire Ventures — "$2.5-4M checks"; Focal — "$500K-$1M for ~10%"; Valor). The highest-ROI enrichment is **SEC Form D filings on EDGAR** — free, structured XML, covers ~85% of US VC funds, contains `offeringData.totalOfferingAmount` for fund size. Divide by typical portfolio count (20–40 for seed, 15–25 for Series A) for a check-size estimate.

**Normalization challenges:** Carta 2024–2025 benchmarks for round sizing (medians):

| Stage | Typical round | Median pre-money | Typical lead check |
|---|---|---|---|
| Pre-seed | $100K–$1M | $5M–$12M | $250K–$1M |
| Seed | $2M–$4M | **$16M (Q4'24)** | $500K–$3M |
| Series A | $10M–$12M | **$47.9M (Q2'25)** | $3M–$10M |
| Series B | $25M–$30M | **$108.9M (Q4'24)** | $10M–$25M |
| Series C | $40M–$60M | ~$200M | $20M–$50M |
| Series D+ | $75M+ | $300M–$1B+ | $40M+ |

AI startups command 30–50% valuation premiums at all stages, reaching 193% at Series E+. Non-AI seed median was ~$12.6M vs. $17.9M for AI (2024).

**NLP extension:** Regex on site text for patterns like `\$\d+[KMkm]?\s*[-–]\s*\$?\d+[KMkm]?` near keywords ("check," "sweet spot," "initial investment") catches a chunk. Layer on Form D enrichment for the rest.

### 6. Thesis and thematic keywords — hard → medium with NLP, ~50% meaningful yield

**Why it matters:** The difference between a "we invest in B2B SaaS" fund and a fund whose actual thesis is "AI-native vertical SaaS for regulated industries" determines partner meeting probability. Signal NFX's matching is essentially thesis-matching.

**Where it lives:** `/thesis`, `/approach`, `/focus`, long-form blog posts. USV famously publishes thesis versions (Thesis 1.0 → 3.0). Bessemer's Roadmaps and a16z's focus-area pages are the richest public theses. On ~35% of sites you get >200 words of usable thesis text; ~55% have a blog.

**Normalization challenges:** **There is no canonical thesis taxonomy.** Each platform invents its own. Signal NFX uses sector × stage matrices. OpenVC uses free-text verticals. VCSheet hand-writes one-line summaries. PitchBook's 85+ Emerging Spaces is the best structured starting point. Recommended hybrid: maintain a ~300-tag controlled vocab (seeded from PitchBook verticals + emerging spaces) and **store raw thesis embeddings alongside**.

```
thesis_text: long-form (concatenate /thesis + /about + blog posts)
thesis_tags[]: multi-select from ~300-tag controlled vocab
thesis_embedding: 3072-d vector for semantic matching
anti_thesis[]: explicit negatives ("no consumer," "no deep tech")
```

Common thematic clusters empirically observed in 2025–2026: **AI infrastructure, foundation models, vertical AI, AI agents/agentic AI, dev tools, open source (COSS), vertical SaaS, PLG, marketplaces, climate tech, defense/dual-use, robotics/humanoids, bio × AI, stablecoins/on-chain finance.** Anti-thesis tags are surprisingly predictive — many funds explicitly list what they won't do.

**NLP extension:** This is where NLP earns its keep. Zero-shot structured extraction (Claude/GPT-4 with JSON schema) on cleaned thesis text fills the structured tags; embeddings handle fuzzy cross-sector matching.

### 7. Lead vs. follow preference — hard direct, medium with Crunchbase

**Why it matters:** Follow-only funds cannot anchor your round. OpenVC and VCSheet treat this as a first-class filter; VCSheet curates dedicated sheets of "Funds that lead pre-seeds."

**Where it lives:** Verbatim phrases on ~20% of sites: "we lead," "co-lead," "first check," "we lead or co-lead," "we set the terms." When these phrases appear, they're ~95% accurate. Otherwise infer from Crunchbase: compute the investor's lead-investor rate across historical deals. >30% lead rate = "genuine lead fund"; >50% = "usually leads." PitchBook reports micro-VCs now lead **41% of US pre-seed deals (2025)**, up from 28% in 2023.

**Schema:**
```
lead_preference: enum [always_leads, usually_leads, co_lead_ok,
                       follow_only, opportunistic]
lead_stages[]: multi-select
lead_check_range: {min, max}
```

### 8. Portfolio composition, partner bios, and activity — easy/medium, high inferential value

**Why it matters:** Portfolio is the most information-dense signal on a VC site and the foundation for inference on every other dimension. Partner bios matter because **the partner is who joins your board** — senior founder voices (Suster, Lemkin, Kupor, First Round) unanimously say partner-level fit is more important than firm-level fit.

**Where it lives:** ~90% of firms have a portfolio page; ~85% yield ≥5 extractable companies. ~95% have team pages with names + titles; ~60% have substantive bios. Activity (recent deals, dry powder) is rarely on-site (~15%) but easy via Crunchbase (~90%).

**Inference power:** Portfolio extraction → Crunchbase lookup → aggregate sector/stage distributions → derive *empirical* sector focus and entry-stage focus. This is the single highest-value scraping workflow because it replaces self-reporting (which funds sometimes misstate or leave vague) with revealed preference.

**What founder advice adds here:** Check for **portfolio conflicts** — NFX flags competitor-in-portfolio as a deal-breaker, noting VCs with invested competitors "might even take a meeting for that reason [to share your data]." This is automatable: embed your startup's description, compute similarity against each portfolio company, flag >0.85 cosine as a conflict.

## The deal-breaker hierarchy: filter vs. rank

Founder-focused advice from Suster, Lemkin, Paul Graham, NFX, First Round, and Elad Gil converges on a hierarchy that differs meaningfully from what database filters emphasize. **Use the hard criteria to filter (disqualify); use the soft criteria to rank (order).**

**Hard filters (disqualifying, automate these as gates):**
- Wrong stage / check size out of range
- Competitor already in portfolio
- Wrong geography (if the fund is explicitly regional)
- No dry powder (fund last closed >4 years ago — Suster's heuristic)
- Wrong business model (fund doesn't do hardware, or marketplaces, etc.)

**Soft ranking signals (order the filtered list):**
- Thesis embedding similarity to your pitch
- Partner-level domain experience (NLP over partner bios — "ex-Stripe, led payments investments" > generic "investor")
- Lead preference match (if you need a lead)
- Recent activity cadence (>1 new investment/month = active)
- Follow-on rate (% of portfolio getting second/third checks — Lemkin's #6 factor, visible on Crunchbase)
- Reputation/brand for signaling (a rough proxy: portfolio quality × Twitter following of partners)
- Geographic proximity (weakly — First Round data shows geo overrated)

**What founder advice warns is overrated but platforms overweight:**
- Brand-name of firm (partner matters more except at Series B+)
- Stated "value-add" and intro networks (Suster: 90% of VCs oversell this)
- Valuation/price match (consistently ranked lowest by senior voices — Suster: "I'm dubious of entrepreneurs who value the highest price")

**What founder advice says is underrated and your system should try to capture:**
- **Partner operator/builder background** (extractable from LinkedIn bio — NFX strongly prefers builders)
- **Follow-on capacity** (Crunchbase: count second+ checks into same company / total investments)
- **Partner tenure stability** (LinkedIn: time at current firm; flag <2 years as risk — a partner leaving mid-cycle is Lemkin's worst scenario)
- **Co-investor quality** (Crunchbase: who do they syndicate with? Top-decile co-investors = signal)

The honest truth is that the #1 factor — **trust in the partner's character, revealed through reference checks with struggling/failed founders** — is not programmatically extractable. Your system should be framed as a *filtering and ranking tool*, not a decision tool. Its job is to take 5,000 → 100; the founder still has to do reference calls on the final 10.

## Taxonomies: practical schemas you can adopt

### Unified investor entity schema (recommended)
```
investor {
  id, name, website, investor_type
  stages_invested[], stage_sweet_spot
  check_size_min, check_size_max, check_size_sweet_spot
  fund_size_aum, fund_vintage, dry_powder_estimate
  can_lead, lead_preference, lead_stages[], lead_check_range
  sector_focus_l1[], sector_focus_l2[], thesis_tags[]
  thesis_text, thesis_embedding, anti_thesis[]
  business_model_focus[], gtm_focus[]
  geography: {scope_type, countries[], regions[], metros[]}
  portfolio_size, portfolio_stage_distribution, lead_rate, followon_rate
  partners[]: {name, linkedin, bio, prior_exits, tenure_years, operator_bg}
  activity: {last_investment_date, deals_last_12mo, typical_cadence}
  contact: {email, form_url, intro_required, linkedin}
  data_source_confidence: {stage: 0.9, check_size: 0.6, thesis: 0.7, ...}
}
```

### Stage × check size normalization table
Use Crunchbase's numeric breakpoints as the machine-readable truth when labels are ambiguous: **< $3M = seed/angel bucket, $3M–$15M = early, >$15M = late, PE after VC = growth**. Store both the self-reported label and the numeric bucket.

### Business model tags (de-facto standard)
Multi-select: `b2b_saas_enterprise, b2b_saas_midmarket, b2b_saas_smb, vertical_saas, horizontal_saas, marketplace_b2b, marketplace_b2c, marketplace_labor, consumer_subscription, dtc_ecommerce, hardware, deeptech, biotech_therapeutics, medtech_devices, open_source_coss, plg, enterprise_sales, api_first, dev_tools, transactional_takerate, ads_media, regulated_fintech, regulated_healthcare, gov_defense, crypto_token, synthetic_bio`. Signal NFX collapses these to five buckets (Enterprise, Consumer Internet, Marketplaces, SaaS, FinTech) — keep both levels.

## Scrape-ability reality check and the layered extraction framework

Tech-stack distribution across VC sites (informed estimate): **~30–40% Webflow, ~25–30% WordPress, ~15–20% custom React/Next.js, ~10–15% Squarespace/Wix, ~5% Notion/Super**. Most are static HTML with CSS animations — good for scraping. Portfolio pages are the main JS gotcha: ~30–40% use client-side filtering widgets, often with the cleanest data embedded as JSON in the page source or fetched via sniffable XHR endpoints. Webflow template reuse is a gift: writing 5–10 template-specific parsers (for BRIX's Investor X, Venture X, Capital and Medium Rare's Partner, Bureau templates) covers a disproportionate share of the long tail.

**Realistic yield per criterion on 5,000 investors:**

| Field | Direct scrape | + enrichment/inference | Final usable |
|---|---|---|---|
| Firm name + URL | 98% | 99% | **99%** |
| Team names + LinkedIn | 90% | 95% | **95%** |
| Portfolio (≥5 companies) | 80% | 92% | **92%** |
| Stated sector focus | 45% | — | — |
| Inferred sector focus | — | 85% | **85%** |
| Stated stage | 40% | 80% | **80%** |
| Geographic focus | 70% | 90% | **90%** |
| Thesis text (>200 words) | 35% | 50% | **50%** |
| Explicit check size | 15% | 70% (Form D) | **70%** |
| Lead vs. follow | 20% | 75% (Crunchbase) | **75%** |
| Recent activity | 15% | 90% (Crunchbase) | **90%** |
| Board seat preference | 5% | 25% | **25%** |
| Diversity focus | 10% | 15% | **15%** |
| Direct contact email | 45% | 55% | **55%** |

### The four-layer extraction architecture

**Layer 1 — Static HTML direct extraction** (covers ~85–90% of firms for basics). Tools: `httpx` + `BeautifulSoup` or Firecrawl markdown mode. Targets: firm name, URL, team/partner names, portfolio logos, contact email, social links, schema.org JSON-LD. Static, deterministic, per-template parsers.

**Layer 2 — JS rendering and targeted parsing** (covers another ~50–60% of structured fields). Tools: Playwright for JS-rendered portfolios, per-template extractors for Webflow CMS collection-lists (`.w-dyn-list`, `.w-dyn-item`), Network-tab XHR sniffing for JSON endpoints behind filterable portfolios.

**Layer 3 — LLM structured extraction + embeddings** (the NLP layer that turns prose into schema). For each fund: clean markdown → send to Claude/GPT-4 with a strict JSON schema → extract stage, check size, lead preference, thesis tags, anti-thesis, diversity focus. Embed the thesis text separately for semantic matching. Budget: $0.02–0.10 per fund × 5,000 × refresh cycles ≈ $300–2,000/mo.

**Layer 4 — External enrichment** (non-negotiable for quality):
- **SEC Form D on EDGAR** — free, official, structured XML quarterly drops. Filter `investmentFundType = Venture Capital Fund`. Single highest-ROI enrichment for fund size and activity.
- **Crunchbase API** — portfolio rounds with lead-investor flag, recency, co-investor graph. Paid but essential for lead-rate and follow-on-rate computation.
- **LinkedIn** (cautiously post hiQ v. LinkedIn) — partner bios, tenure, operator backgrounds, recent posts. Use Proxycurl API for defensibility rather than direct scraping.
- **Signal NFX, OpenVC, VCSheet** — pre-structured investor data. OpenVC's CSV export of 16,000 verified investors is the fastest shortcut; Signal NFX has the strongest sector × stage curation.

### Legal and operational guardrails

Public VC firm websites are low-risk under the hiQ v. LinkedIn precedent (9th Circuit 2022 affirmed public data scraping under CFAA). Most VC sites have no restrictive TOS. Aggregators (Crunchbase, PitchBook, Signal NFX, LinkedIn) do — use their APIs or accept contract-breach risk. Rate-limit to 1 request per 2–5 seconds per domain; parallelize across domains, not within; use a descriptive User-Agent with contact email; respect robots.txt and Retry-After. Re-scrape cadence of 30–90 days is appropriate — VC sites change slowly but ~10–15% of your data will be stale within 6 months.

### Three architectural commitments that will save you months

First, **don't build 5,000 custom parsers.** Build ~5–10 template-specific parsers covering the common Webflow and WordPress templates, plus one LLM-based generic fallback for the long tail. This hybrid beats both pure-custom and pure-LLM approaches on cost and precision.

Second, **start by ingesting OpenVC's CSV + Signal NFX data, then augment.** Pure-scraping from scratch duplicates 6–12 months of engineering work that's already been done. Your differentiation should be in the matching layer and the freshness layer, not in rebuilding the directory.

Third, **treat the whole thing as a two-stage funnel: hard filters narrow 5,000 → ~100, then soft ranking (embedding similarity + weighted scoring on lead preference, follow-on rate, partner operator background) orders them.** Do not try to produce a single "match score." Founders will reject that as a black box. Expose the individual signals so they can see *why* a fund ranked where it did, and let them re-weight.

## Conclusion: three insights that should shape Qurio's matching system

The first insight is that **scrape-ability and decision-importance are inversely correlated** for the criteria founders care most about. Stage and geography are easy to extract and matter (as filters). Thesis fit, partner character, and follow-on behavior matter more — and are harder to extract, requiring portfolio-pattern inference, Crunchbase lead-rate computation, and LinkedIn-sourced partner tenure data. A system that only uses what's easy will produce a mediocre match score; a system that commits to the inference layer will produce something meaningfully better than what OpenVC and Signal NFX currently offer founders.

The second insight is that **portfolio data is the universal substrate**. Sector focus, stage focus, lead behavior, follow-on willingness, co-investor quality, activity cadence, and conflict detection all derive from the same extracted list of portfolio companies enriched with Crunchbase round data. If you do one thing extremely well, make it portfolio extraction + Crunchbase cross-reference. Everything else compounds from there.

The third is a productization lesson: what makes this useful to other founders (not just you) is **exposing the full signal decomposition rather than hiding it behind a match score**. VCSheet's lasting value is its hand-written per-fund narrative; Harmonic's is its natural-language query; OpenVC's is the 10 transparent filter axes. Founders are rightly skeptical of black-box "fit" scores. Your wedge — if you take the hybrid hard-filter-plus-embedding-rank architecture — is showing founders *which* of the eight criteria each fund matches on, with confidence scores reflecting whether the data was scraped, inferred, or enriched. That's the version worth productizing.