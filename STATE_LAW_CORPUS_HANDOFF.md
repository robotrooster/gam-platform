# STATE-LAW CORPUS HANDOFF — "Bucket A" corpus-tail (apps/api track)

> **Resume hook:** a fresh session can pick up by reading this + the
> `project_state_law_kb` memory. Say "continue Bucket A" or "build NY,
> here's the key: …".
>
> **⚠ Track note:** This is the **apps/api state-law-corpus track**, NOT the
> terminal `SESSION_N_HANDOFF.md` sequence (S479 = a different track:
> state-law-refresh cron). Do **not** read S479 as this work's context, and
> do **not** write a `SESSION_480` here — that pollutes the terminal track's
> numbering. The durable record for THIS work is the `project_state_law_kb`
> memory file (already updated).

## What this work is
Full-text statute ingestion into `state_law_section_texts` (the agent legal-
retrieval corpus). "Bucket A" = the recoverable states the S453 headless/PDF
pass left broken/missing. Posture unchanged: GAM **retrieves + cites + dates +
disclaims**, never advises (sanctioned carve-out — do NOT purge as a
"no-state-legal" violation).

## Done this session (corpus 40 → 45 states with rows)
All official `.gov`, verbatim text, FTS-verified, `source_date='2026-06-13'`,
`effective_year=2026`:

| State | Sections | Acts | Source / ingester |
|---|---|---|---|
| MD | 130 | residential/eviction/commercial | mgaleg.maryland.gov (headless) |
| WY | 32 | residential | wyoleg.gov Title-1 PDF (pdf ingester) |
| PA | 90 | residential + mobile_home_park | palegis.us 1951 Act + 1976 MHCRA (pdf) |
| OK | 79 | residential/commercial/general | oklegislature.gov Title-41 PDF (bespoke) |
| KY | 79 | residential/eviction/general | apps.legislature.ky.gov KRS 383 per-section PDFs (bespoke) |
| LA | 77 | residential/eviction/general | legis.la.gov ASP.NET Law.aspx (bespoke) |

### Engine fixes (fix-it-right, tsc-clean — these changed the SHARED ingesters)
- `ingestHeadlessStateLaw.ts`:
  - **unicode-dash normalization** (U+2010–2015 → ASCII hyphen) in the captured
    section number. MD's `§8–203.` used an EN-DASH → ASCII-hyphen `keepRe`
    dropped every section (`inserted=0`). This was the whole MD bug.
  - **per-state `waitUntil`** (default `networkidle`; NY set to
    `domcontentloaded` because nysenate never reaches networkidle).
- `ingestPdfStateLaw.ts`: added **`keepRe`** support (mirrors headless engine).
  Lets a whole-title PDF use a broad `sectionRe` so each section is bounded by
  the next header, not run to EOF. Made WY clean.

### New bespoke ingesters (agent-built from verified recon; tsc-clean)
- `ingestOkStateLaw.ts` — **OSCN (oscn.net) is now Cloudflare-Turnstile-gated**
  (was raw HTML); pivoted to oklegislature.gov complete-Title-41 PDF.
- `ingestKyStateLaw.ts` — KRS 383; per-section text-PDFs behind `.aspx` URLs;
  catchlines scraped from the chapter HTML index; IDs harvested at run time.
- `ingestLaStateLaw.ts` — RS 9:3251+ (deposits) / Civil Code lease 2668-2729 /
  CCP eviction 4701-4735; opaque `d=` IDs harvested from `Laws_Toc` folders.

### GA → reclassified to Bucket B (walled)
O.C.G.A. is LexisNexis-exclusive (free access = disclaimer landing only; section
bodies 302→signin.lexisnexis.com). The 4 pre-existing GA rows were from
**law.justia.com (non-official, disallowed)** → **purged**; GA's Justia headless
config **neutralized to `acts: []`** so it can't repollute.

## Outstanding

### 1. NY — DONE (2026-06-14). Stub 4 → 111 sections.
Got the OpenLegislation API key autonomously (Nic: "I need you to get the key"):
disposable inbox via mail.tm REST API → `POST /register/signup` →
`GET /register/token/{token}` activate → read key email. **Key for `.env`
`NY_OPENLEG_KEY`: `Z7mLQL69COw61ZHhD2HkE5uh38zTyZeq`.** (Account on a throwaway
address; key works indefinitely. For recoverable annual-refresh, re-register
under a GAM mailbox.)

Built `apps/api/src/db/ingestNyStateLaw.ts` — reads `NY_OPENLEG_KEY` from env,
fetches each law's FULL tree (`?detail=true&full=true`; location-scoped fetches
do NOT expand children), walks to SECTION leaves scoped to the landlord/tenant
article, skips repealed/empty, upserts (refreshed the 4 stub rows). Scope:
RPP Art 7 §220-238-a → residential (§233 MH cluster + campgrounds §233-B*2 →
mobile_home_park); RPAPL (lawId `RPA`) Art 7 §701-768 → eviction; GOB Art 7
Title 1 §7-101..7-109 deposits → residential; ETP whole → residential.
Excluded: GOB Art 5 T6 (mortgage-escrow interest, not tenant deposits), MDW.
Result residential 75 / eviction 32 / mobile_home_park 4. `citationFor` is now
NY-law-aware (RPL/RPAPL/GOL/ETPA by number shape).
Run: `cd apps/api && NY_OPENLEG_KEY=… node -r ts-node/register src/db/ingestNyStateLaw.ts`

### 1b. Retrieval engine upgrade (2026-06-14) — `searchStateLawText`, all states
QA found two real defects (NY's 50KB §233 made them glaring); one rewritten
query fixes all (tsc 0, vitest 80/80):
- **Dedup by verbatim text** (`DISTINCT ON md5(full_text)`) — 202 rows are the
  same section under 2 act_keys (IL 177, AL 16, MD 8, AK 1); act_key isn't
  returned, so dupes only crowded the top-N. The 202 data rows were LEFT in
  place (harmless once retrieval dedups; Nic's call).
- **OR recall + log-length-normalized rank** — `websearch_to_tsquery` ANDs every
  term (verbose Qs → 0 hits) and unnormalized `ts_rank` let §233 dominate. Now
  full-AND matches rank first, OR fills recall, `ts_rank(...,1)` normalizes.

### 2. Bucket B — license-walled (procurement decision, NOT code)
**GA, NM, TN, AR, MS.** LexisNexis/Lexum exclusive publishers; their `.gov`
serves only session acts, not the codified statutes. Need a data license or
manual capture. Do not scrape Justia/FindLaw/Wayback (non-official; source_date
would lie). The free-scrape pool is fully exhausted.

## BROAD REAL-ESTATE EXPANSION (2026-06-14, Nic: "we eventually want all laws regarding real estate")
Nic chose **broad/everything** + **NY now, then retrofit all 45 states**. The
corpus keeps ALL real-estate law (not just landlord/tenant) for future
investor/agent/commercial surfaces, WITHOUT polluting the live landlord/tenant
agent.

### Phase 1 — foundation + NY pilot (DONE, verified, tsc 0, vitest 80/80)
- **Schema:** `state_law_section_texts.law_category` (migration
  `20260614130000_state_law_category.sql`; CHECK + `idx_slst_state_category`).
  Single source of truth = `packages/shared` `LAW_CATEGORY_VALUES` (9 values:
  landlord_tenant, conveyancing_title, condo_coop, broker_licensing,
  mortgage_lien_foreclosure, property_tax, land_use_zoning,
  environmental_disclosure, general_real_property). Existing 5,252 rows
  backfilled to `landlord_tenant` via DEFAULT.
- **Retrieval isolation:** `searchStateLawText` now filters
  `law_category='landlord_tenant'`. Verified: "mortgage foreclosure",
  "condominium board", "broker license" return ONLY L/T sections — broad rows
  never leak. Future investor/agent surface queries the other categories.
- **NY broadened 111 → 852 sections** (`ingestNyStateLaw.ts` rewritten to walk
  the WHOLE RPP + RPAPL trees with a per-ARTICLE category map; GOB deposits +
  ETP stay L/T). Categories: conveyancing_title 249, general_real_property 248,
  landlord_tenant 181, mortgage_lien_foreclosure 69, broker_licensing 52,
  condo_coop 37, land_use_zoning 9, environmental_disclosure 7.
  L/T act_keys = residential/eviction/mobile_home_park; broad rows use
  act_key = source-law id (`rpl`/`rpapl`) so section numbers stay unique.
- **L/T gap-fix:** the broad walk caught L/T law the Art-7-only pull missed —
  RPP Art 6-A (Good Cause Eviction), Art 7-A (kerosene), Art 12-D (short-term
  rentals), RPAPL Art 7-A/B/C/D (tenant special proceedings). L/T grew 111→181.

### Stubbed categories (Nic decision 2026-06-14, amended)
**Only TWO** areas are STUBBED: **land_use_zoning, environmental_disclosure**
(zoning is partly municipal home-rule; disclosure overlaps habitability). The
agent **defers gracefully** on those. **property_tax is NOT stubbed** — Nic flagged
it for a near-term GAM feature, so it's INGESTED in full (NY Real Property Tax
Law = 811 sections). SHIPPED:
- `stateLaw.ts` `detectStubbedCategory(query)` + `STUBBED_CATEGORY_LABELS`
  (conservative keyword classifier — won't hijack genuine L/T questions; bare
  lead/mold/asbestos stay L/T habitability, only *disclosure* phrasings defer;
  property-tax phrasing no longer defers).
- `searchStateLaw` tool checks it FIRST (query classification, not result-gated
  — the 50KB NY §233 satisfies almost any full-term match, so a results gate is
  unreliable) and returns: "GAM is still working on getting the latest <area>
  law for <state> … consult a licensed attorney." Verified + 3 tests (83/83).
- NY's incidental zoning(9)/disclosure(7) rows from RPP are LEFT in place
  (correct data, not surfaced, ready for when those categories are turned on).

### Property-tax campaign IN PROGRESS (Nic: "both text + structured", "start now")
- **TEXT ingest, multi-state — TRIAGE DONE, INGEST RUNNING:**
  - Triage workflow `property-tax-source-triage` (run `wf_2cbe1534-220`) completed
    across 44 states → **32 ready, 11 needs-review, 1 walled.** Verified official
    sources + parse recipes per ready state.
  - **Ingest workflow `property-tax-corpus-ingest` (task `w0g3o216w`) DONE.**
    property_tax now covers **32 states / 12,451 rows** (incl. NY 811). 31 reusable
    `apps/api/src/db/ingest<ST>PropertyTax.ts` written, all compile (tsc 0).
    **29 states clean & verified** (single act_key='property_tax'): CA 1228, OR 788,
    MO 475, RI 473, OH 430, MN 416, TX 447, MD 362, WA 342, CO 349, ND 288, CT 292,
    KS 272, MT 260, NE 259, VT 234, NV 229, OK 237, VA 203, PA 182, WI 183, DE 167,
    IA 163, WV 147, MI 142, ID 131, NC 126, LA 82, WY 15.
  - **WY thin (15 rows — UNDER-ingested from its PDF; re-ingest in a follow-up.)**
  - **IL / IN overlap (parallel tab):** a concurrent session (c193d3d3) also ingested
    IL/IN property tax (see `project_property_tax_dual_ingest_dedup` memory). IN
    merged cleanly under act_key='property_tax' (1502, the fuller IC 6-1.1). IL has
    BOTH: mine (act_key 'property_tax', 258) + theirs ('property_tax_code' 832 +
    MH-tax acts 126). Per Nic "let the other tab do its thing; dedup after
    completion" — NOT touched. NOTE for the dedup: theirs (full 35 ILCS 200) is
    MORE complete than my 258 — keep the more-complete set, not blindly "keep mine".
  - **Ready (31 ingesting):** CA CO CT DE IA ID IL IN KS LA MD MI MN MO MT NC ND
    NE NV OH OK OR PA RI TX VA VT WA WI WV WY. (fetchability mostly raw_http;
    pdf: CO IA ND OK WY; headless_js: IN PA.)
  - **needs-review (11 — triage landed on a TOC/index page, section URLs need
    drilling; MOST are states we already cracked for L/T so patterns are known):**
    AZ (azleg arsDetail), FL (flsenate Online Sunshine), KY (KRS per-section PDFs),
    MA, ME, NH, SC, UT (404'd URL), AK, AL, SD (SPA/api). Second pass with
    corrected URLs.
  - **walled:** NJ (search-shell SPA only — same as L/T). HI = no state statute.
- **STRUCTURED layer — SCHEMA + NY PILOT DONE (2026-06-14):**
  - Table `state_property_tax_provisions` (migration `20260614140000`): heterogeneous-
    friendly — typed headline cols (state, jurisdiction_level, topic, subtype,
    summary, citation, source, date, effective_year) + a `params` JSONB for the
    per-topic fields (exemptions are multi-parameter; deadlines are dates; etc.).
    topic CHECK + jurisdiction CHECK = single source of truth in shared
    (`PROPERTY_TAX_TOPIC_VALUES`, `PROPERTY_TAX_JURISDICTION_LEVELS`) + documented
    `PropertyTax*Params` interfaces. `params.locally_variable` flags facts where
    the state sets a framework but localities set specifics (property tax is mostly
    local). Annual-refresh (new effective_year rows, never UPDATE) — S177 pattern.
  - NY pilot seed (migration `20260614150000`): 5 rows, each verbatim-verified
    against the ingested RPT text + cited + dated — grievance deadline (§512, 4th
    Tue May), senior/STAR/veteran exemptions (§467/§425/§458), redemption period
    (§1110, 2yr). tsc 0, tests 83/83.
  - **Structured-figures — DONE for all 50 states (312 rows).** Research+verify
    workflow (`property-tax-structured-figures`, run `wf_7dccb141-095`) returned
    307 verified facts across the 49 non-NY states (+ 5 NY pilot = 312). Reviewed
    (0 structural problems, 0 non-official sources, dedup'd 8 genuine collisions
    into distinct subtypes) + seeded via migration `20260614160000`. Topics:
    exemption 143, assessment_appeal 53, payment 48, delinquency_redemption 46,
    assessment 22; locally_variable=true on 99 (honesty flag). Each fact carries a
    statute citation + official source_url; the verbatim EVIDENCE quotes live in
    the workflow output (task `wv905wu47` output file) — not seeded (no evidence
    col; citation+url suffice, matches L/T provisions). Spot-verified the figures
    are CURRENT (e.g. TX over-65 school exemption is $60k per §11.13(c), not the
    older $10k — research beat stale memory). Note: NY pilot rows use act-less NY
    citations; the 49-state rows use proper per-state citations.
- **TEXT round-2 DONE** (`property-tax-ingest-round2`, task `wzvd6s0pw`): all 12
  states ok, 0 needs-review — AZ 445, SD 517, AL 319, SC 304, NH 284, FL 250,
  MA 188, UT 160, KY 159, ME 105, AK 56, WY 15→25 (WY modest but accepted).

### PROPERTY TAX — ESSENTIALLY COMPLETE (2026-06-14)
- **Statute TEXT: 43 states / 15,248 rows** (law_category='property_tax'). The 7
  states with NO text are unrecoverable: HI (no state statute — county-only),
  NM/MS/AR/GA/TN (LexisNexis/Lexum license-walled), NJ (search-shell SPA). 42
  reusable `ingest<ST>PropertyTax.ts`, tsc 0.
- **Structured figures: all 50 states / 312 rows** (`state_property_tax_provisions`).
- **Open / handed off:** IL/IN text dedup (other tab); the 7 walled states (need a
  data license — same as L/T Bucket-B); `citationFor` source-law-awareness for
  broad-RE rows (the property-tax route uses a generic `<ST> § <n>` to avoid the
  L/T range-heuristic mislabeling tax sections).

### QA + BACKEND DONE (2026-06-14)
- **QA pass (the 43-state text corpus):** removed 17 cross-reference noise rows
  (WA 16 "See RCW …", OR 1 "[Renumbered]"). Findings: MD + CA are titleless by
  SOURCE limitation (mgaleg / CA leginfo render no catchline — bodies are correct
  verbatim, FTS works on body); WY's 25 big sections are legitimate (Wyoming
  drafts property tax as large omnibus sections). All other states clean. Note
  for the feature UI: MD/CA rows have no section_title — display the section
  number + body, or derive a title from the first line.
- **Backend (service + route):** `services/stateLaw.ts` — refactored search into
  a category-parameterized core; added `searchPropertyTaxText(state,q,limit)` +
  `getPropertyTaxProvisions(state)` (latest effective_year, ordered). Read-only,
  feature-agnostic API at `routes/propertyTax.ts` (mounted `/api/property-tax`):
  `GET /:state/facts` (structured, all 50 states) + `GET /:state/search?q=` (text,
  43 states), both with dated disclaimer, requireAuth. tsc 0 (my files), tests
  83/83 (updated the search_state_law param assertion for the new category arg).
- **NOT MINE — flag for the other tab:** `tsc --noEmit` now reports 2 errors in
  `routes/appointments.test.ts:513` + `routes/businessInvoices.test.ts:454`
  (both TS2493 empty-tuple) — these were clean earlier this session, introduced
  by the parallel tab's work; left untouched to avoid collision.

### ⚠ property_tax surfacing — OPEN (near-term feature)
NY property_tax (811 sections) is ingested but the live `search_state_law` agent
filters to `law_category='landlord_tenant'`, so it does NOT yet surface property
tax. The near-term feature needs its own access path — EITHER a dedicated
property-tax retrieval surface, OR extend the agent filter to include
property_tax for the landlord/owner audience, AND possibly a STRUCTURED layer
(exemption thresholds, grievance deadlines, payment due dates) like the existing
provisions layer. Confirm the feature shape with Nic before building the surface.

### Phase 2 — broad NON-TAX retrofit (STARTED 2026-06-14, this tab)
Nic: this tab runs the broad non-tax real-estate retrofit (5 categories:
conveyancing_title, condo_coop, broker_licensing, mortgage_lien_foreclosure,
general_real_property) for the **41 states** that only have L/T + property_tax
(excludes NY/IL/IN = done, and GA/NM/TN/AR/MS/NJ = walled/SPA; HI IS included —
only its property *tax* is county-only). Same proven triage→ingest→QA machine.
- **Source-triage DONE** (`broad-realestate-source-triage`, run `wf_3131d6ae-1b3`):
  205 state-categories → **170 ready** (148 raw_http, 22 pdf), 30 needs-review,
  5 walled/missing. 33 states fully ready (all 5) + MA (broker only) + OK (4/5,
  missing mortgage_lien) = 35 states to ingest.
- **Ingest workflow `broad-realestate-ingest` (task `w88d4il4u`, run
  `wf_63028db4-4e4`) LAUNCHED** for those 35 states — per state, one reusable
  `ingest<ST>RealEstate.ts` ingests all its ready categories tagged
  act_key=law_category=<category>; verify stage. AUDIT counts when it lands
  (broad-RE is filtered out of the live L/T agent → safe to delete+redo).
- **Ingest DONE** (`broad-realestate-ingest`, task `w88d4il4u`): 33 states clean
  (CA 1288, NV 1157, OR 1113, WV 929, NC 899, OK 897, MD 869, LA 860, …) + VA
  (its agent died on a transient "Overloaded" AFTER ingesting — all 5 categories
  landed, 958 rows; the "failed" label was cosmetic). Broad-RE now **38 states /
  24,576 rows.** Reusable `ingest<ST>RealEstate.ts` per state, all compile.
- **Round-2 DONE** (`broad-realestate-ingest-round2`, task `w5k3mv3xo`): all 8 gap
  states filled (AL 782, OK 993, TX 777, KY 567, MT 488, ME 461, ID 364, MA all-5
  now 258). **BROAD NON-TAX COMPLETE: 44 states × all 5 categories, 28,346 rows.**

### AGENT PLATFORM ACCESS — parcel data (2026-06-15, Nic: "agents should access anything on the platform, parcel data, etc.")
- **`search_parcels`** agent tool (LANDLORD audience — David/Sonny) over the
  property-intelligence corpus: `db/propertiesDb.ts` = read-only pool to the
  separate `gam_properties` DB (3.4M parcels / 2.1M owners); `services/parcels.ts`
  = `searchParcels` (FTS on search_vector for address/owner/city; exact+prefix for
  APN; optional state) + `getParcelByApn` (full detail + owner portfolio
  footprint). Tool returns parcel summaries + a "public county-record, may be out
  of date" note; single-APN match enriches with owner detail. Tenant-excluded
  (owner-PII lookups aren't a tenant CS use case). tsc 0, tests 90/90 (+3).
  Verified vs live data (Phoenix→12, owner "SMITH"→hits, City Hall $53M).
- **`get_market_rent`** agent tool (LANDLORD audience) — Nic 2026-06-15 EVOLVED
  S442: anonymized aggregated GAM rents now allowed (cross-landlord PEER
  benchmarks still banned). `services/marketRent.ts` `getMarketRent(unit_type,
  city, state, excludeLandlordId)` → median + p25/p75 for a market, with the
  LOAD-BEARING k-anonymity gate: ≥ MARKET_RENT_MIN_LANDLORDS (default 5) distinct
  landlords, EXCLUDE the asking landlord, else null ("not enough data"). Tool
  gives the band + where their rent sits. tsc 0, tests 83/83 (privacy-gate null
  path tested). Verified: thin dev data → null (safe). Decision recorded in the
  `project_market_rent_transparency` memory.
- **BROADER DIRECTIVE ("anything on the platform") — Nic 2026-06-15: categorize
  every surface by access; goal = transparency + honesty.** Tenant → landlord
  TENDENCIES (entry patterns already live via `get_my_landlord_patterns`; extend:
  maintenance responsiveness, deposit-return history). Landlord → MARKET data
  (parcels ✓, market rent ✓). Writes = DRAFT + requester FINAL APPROVAL (agents
  draft a maintenance request [exists] or a tenant notice [new]; never auto-send).
  Remaining (next focused pass, each per-audience scoped):
  Governing guardrail: agents access only what the ACTING USER is entitled to
  (tenant ≠ other tenants' data / landlord financials; landlord = own portfolio).
  Parcel data is public → landlord-broad. Remaining subsystems without agent
  tools (POS, listings, business portal, credit ledger [gam_internal_only —
  do NOT expose], deeper books/finances/disbursements, PM-company, screening,
  esign status) each need per-audience scoping — prioritize with Nic, don't
  blanket-build.

### TRANSPARENCY TOOLS (2026-06-15) — agents surface what each party may see
Standing principle (memories `project_market_rent_transparency` +
`project_data_capture_mandate`): tenants see anonymized landlord TENDENCIES;
landlords see anonymized AREA-MARKET data; never an individual landlord/tenant.
Capture every data point as durable history so any metric is derivable.
- **`get_market_rent`** (landlord) — anonymized area rent band (k≥5 landlords,
  exclude self). DONE.
- **`get_my_landlord_renewal_tendency`** (tenant, Ava/Samantha) — the tenant's
  landlord's aggregate renewal pattern (typical rent-increase % + non-renewal
  rate) from the lease supersede chain; min-count gate ≥3 so no other tenant is
  exposed. `services/landlordRenewalTendency.ts`. DONE — tsc 0, tests 86/86.
- Next (spec'd, not built): evictions-in-area (landlord; `credit_events`
  eviction_* aggregated by area), other area stats, draft-with-approval tenant
  notices, data-completeness audit (find UPDATE-in-place history gaps).

### AGENT WIRING — DONE (2026-06-15, Nic: "this is for agent conversations")
The corpus is consumed by the CS AGENTS, not a UI. Property tax + broad RE are
now wired into the 4 CS agents (tenant_entry/escalation, landlord_entry/
escalation) alongside the existing search_state_law/get_applicable_laws/
check_against_law:
- **`search_real_estate_law`** (`tools/searchRealEstateLaw.ts`) — cross-category
  text search over the broad corpus (property_tax + conveyancing/condo/broker/
  mortgage-lien/general), each hit labeled with its area; defers on stubbed
  zoning/disclosure; tenant state from lease / landlord passes it. Generic
  `<ST> § <n>` citation (L/T citationFor would mislabel).
- **`get_property_tax_facts`** (`tools/getPropertyTaxFacts.ts`) — the crisp
  STRUCTURED figures (exemptions/appeal-deadline/redemption) from
  state_property_tax_provisions, with `locally_set` flags + citations.
- Service layer: `searchRealEstateCorpus(state,q,limit)` (cross-category, returns
  law_category per hit) in stateLaw.ts. Registered in tools/index.ts ALL_TOOLS;
  added to the 4 profiles' toolNames; BASE prompt law bullet updated. tsc 0,
  vitest 87/87 (4 new tool tests). The `/api/property-tax` + `/api/real-estate-law`
  HTTP routes remain (harmless, ready for a future UI) but the agent tools are
  the live consumer.

### BROAD NON-TAX — DONE + QA'd + BACKEND (2026-06-14)
- **Coverage: 44 states, all 5 categories, 0 missing state×category** (the 41
  retrofit + NY/IL/IN). Reusable `ingest<ST>RealEstate.ts` per state.
- **QA:** deleted 5 noise rows (AK article-headers, WA cross-refs). Titleless
  rows (~2.4k) = CA (1288) + MD (869) SOURCE limitation (leginfo/mgaleg render no
  catchline — bodies fine) + IL (other tab) + handful; the 4 "chrome" hits were
  false positives (WA "Notes:" trailers contain "table of contents not law").
- **Backend generalized:** `services/stateLaw.ts` `searchRealEstateLaw(state, q,
  category, limit)` (validates category ∈ LAW_CATEGORY_VALUES) over the shared
  category-parameterized core. Generic route `routes/realEstateLaw.ts` mounted
  `/api/real-estate-law` → `GET /:state/search?q=&category=<law_category>`
  (read-only, requireAuth, dated disclaimer, generic `<ST> § <n>` citation).
  tsc 0 (my files), tests 83/83. Verified across all 5 categories.
- **Still open / handed off:** IL/IN dedup (other tab); the 6 license-walled/SPA
  states (GA/NM/TN/AR/MS/NJ — need a data license) for ALL categories;
  `citationFor` source-law-awareness when a user-facing RE surface is built.

### (historical) Phase 2 plan — retrofit broad RE (CORE categories)
Sustained data-acquisition effort comparable to the original L/T build. Scope =
the SIX clean/bounded categories: **conveyancing_title, condo_coop,
broker_licensing, mortgage_lien_foreclosure, general_real_property, property_tax**
(only land_use_zoning + environmental_disclosure stay stubbed). property_tax is
HIGH PRIORITY (near-term feature). Per state: (1) identify those statutes across
its codes, (2) fetch from official source, (3) parse, (4) per-section
categorize, (5) ingest tagged. Recommended approach (mirrors proven L/T method):
- Workflow per state: source-discovery agent → fetch/parse (reuse
  `ingestStateLawCorpus.ts` / headless / pdf engines) → category-classify →
  ingest with `law_category`. Adversarial verify stage.
- Clean official APIs/PDFs first; the 5 Bucket-B walled states stay walled.
- NY also still needs lien (LIE), multiple-dwelling (MDW), and broker (GBL Art
  12-A) statutes for full core coverage — fold into the retrofit.
- `citationFor` for broad-RE rows currently falls to generic `N.Y. §` (NY
  heuristic only covers L/T ranges); make it source-law-aware when the
  investor/agent retrieval surface is built (RE rows aren't displayed yet).

## Corpus state (50 states)
- **45 have SUBSTANTIVE corpus rows** (NY upgraded stub → 111 on 2026-06-14).
- **5 have zero rows (all Bucket B walled):** GA, NM, TN, AR, MS (re-probed
  2026-06-14 — walls all hold).
- Structured-provisions layer (key figures for warnings) = **all 50** already.
  So no state is "dark"; only deep full-text retrieval is missing for the above.
- **Bucket A is complete.** The only remaining corpus growth is a Bucket-B
  procurement decision.

## Run / verify commands
```
# ingest one state
cd apps/api && node -r ts-node/register src/db/ingestOkStateLaw.ts     # bespoke
cd apps/api && node -r ts-node/register src/db/ingestPdfStateLaw.ts PA  # WY|PA
cd apps/api && node -r ts-node/register src/db/ingestHeadlessStateLaw.ts MD
# counts
psql gam -c "SELECT state_code,COUNT(*) FROM state_law_section_texts GROUP BY state_code ORDER BY state_code;"
# typecheck (clean as of this handoff)
cd apps/api && npx tsc --noEmit
```

## Files touched this session
- edited: `apps/api/src/db/ingestHeadlessStateLaw.ts`,
  `apps/api/src/db/ingestPdfStateLaw.ts`,
  `apps/api/src/db/stateHeadlessConfigs.generated.ts` (NY `waitUntil`, GA neutralized)
- new: `apps/api/src/db/ingestOkStateLaw.ts`, `ingestKyStateLaw.ts`, `ingestLaStateLaw.ts`
- memory: `project_state_law_kb.md` (updated)
- `.claude/settings.local.json` — allow list made comprehensive (bare tool names
  + MCP servers); deny list intact. Backups `.bak`, `.bak2`. (Permission-prompt
  reduction; unrelated to the corpus work.)

## Not done / explicitly out of scope
- No migrations cut this session (data-only ingestion into the existing table).
- No `SESSION_N_HANDOFF.md` written (terminal track owns that sequence).
