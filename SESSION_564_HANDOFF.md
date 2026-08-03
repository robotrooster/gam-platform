# SESSION 564 HANDOFF

**Theme:** Cash-rail research for unbanked/remote-landlord tenants → decided **Chime primary, PayNearMe parked**. README de-staling. Then designed + **started building the landlord-less "renter pool" background-check feature**. All work UNCOMMITTED. Nic left for the night mid-build with "build what you can, save questions for the morning."

---

## 1. Cash rails for unbanked tenants (research — decisions locked, no code)

Context: fully-remote landlords whose tenants may be unbanked / cash-preferred (esp. rural). Researched real options + costs.

- **Chime = the primary answer, ZERO build.** A Chime account is a real DDA with ACH; a Chime rent payment is a **normal Stripe ACH** into GAM's platform balance — existing rail, existing platform-holds batch, standard ACH economics. We just publish a help page ("no bank? open Chime, load cash free at Walgreens / cheap at Dollar General, pay here"). Only friction = opening the account (SSN + ID, **no ChexSystems** so it reaches the previously-unbankable; no credit check). Minor caveat: neobank ACH occasionally returns (R01/NSF) — reliability nuisance, not a fee, invisible to SOC 2, negligible vs NACHA thresholds at our scale.
- **PayNearMe = parked contingency.** True cash-at-register (35k+ stores incl. **Dollar General**, 19k stores, ~75% of US within 5 mi — rural bullseye), **$4.99 tenant-paid**, settles via ACH to a **bank** (not Stripe) in 1–2 biz days. Its ONLY edge over Chime = **no account needed** (reaches no-SSN/undocumented/won't-bank). Nic keeping an **informational call only, no commitments**. Not building now.
  - If ever built: **rail-neutral pricing = PayNearMe wholesale + $3 GAM markup** (matches the ACH $3 spread; ~$7.99 tenant). Cost stack GAM must cover on cash: bank→Stripe top-up (~$0.30) + Connect payout (0.17% + $0.25). Nets ~+$1.20–1.80 on target low rents; goes underwater ~$1,400 rent (flat markup vs % payout) — irrelevant for this population. Per-property minimum = Nic's per-unit-revenue-floor philosophy, only strictly needed if PayNearMe's direct deal carries a monthly/fixed fee (unknown — needs their quote).
- **Benchmark:** Yardi (WIPS) + AppFolio both run **PayNearMe underneath**, both charge tenant **$4.99 / landlord $0**. Market standard = tenant-pays-flat, landlord-free. The Rentec $200 setup + $49.90/mo min is a reseller outlier, NOT PayNearMe's intrinsic pricing (a direct/API integration aggregates all landlords under GAM as merchant-of-record and kills the per-landlord fee).
- **Stripe has NO US retail-cash rail** (only intl vouchers — OXXO/Boleto/konbini). A tenant **Connect account does NOT help** — Connect is a payout construct, can't be funded with physical cash; the "instant" only applies to money already in Stripe.
- **Payout-timing side-thread (resolved, no change):** the platform→Connect transfer is instant+free, but Connect→bank is standard **T+1–T+2 ACH** — that's why the batch initiates Tuesday to land by Friday (D1). Letting landlords self-withdraw doesn't speed the bank leg; leave as-is. Only free lever = Tue→Wed if the live account proves reliably T+1 (checked at C4).

## 2. README.md de-staled (DONE, uncommitted)

Root cause of "old prices keep resurfacing" = the README carried a **frozen second copy** of strategy labeled **"Locked Model v3"** (advance/SLA, $15/mo landlord fee, $20 float, guaranteed-on-the-1st, AZ § citations, reserve phases). **Removed** all of it; replaced with a 4-line current-model summary that **points to `CLAUDE.md` as the single source of truth** (so strategy isn't duplicated to drift again). Kept + de-Arizona'd Eviction Mode; kept NACHA-monitor note; kept ODFI-at-scale *strategy* (added: SOC 2 Type II is the ODFI prerequisite) but stripped its stale per-unit $ figures. Each removal dated 2026-07-28 w/ "git preserves originals." Tagline no longer claims the dead SLA. **Dev-setup half is still dated** (lists 5 of ~13 portals, references docker-compose vs dev.sh) — left it; offered to refresh separately.

## 3. Renter-pool background check — landlord-less screening (BUILD STARTED)

**The ask:** an applicant who doesn't know where they'll live yet completes a background check **not tied to any landlord** → lands in a pool → admin (or landlords self-serve) assign/contact them later. "Extra avenue for a check to process soon."

**Recon verdict: ~80% of the mechanism already exists.** `background.ts` has an explicit **"speculative" intake mode** (no landlordId → on complete, `upsertPoolEntry` → `application_pool`, the landlord-agnostic pool). Landlords browse **anonymized** pool previews and pay **$1 (`POOL_REPORT_UNLOCK_USD`) to unlock contact** — it is **lead-gen, NOT a new check** (Nic confirmed this is exactly his intent; my earlier "landlord re-pulls" read was wrong).

### Locked design decisions (Nic, this session)
- **Checkr is wired for the Checkr *Tenant* API** (`tenant.checkr.com`, `backgroundProvider.ts`). Needs 3 env: `CHECKR_API_KEY` (= the "secret key" = the bearer token, ONE value), `CHECKR_WEBHOOK_SECRET` (the "secondary key" — from the webhook you created, shown once), `CHECKR_PACKAGE` (starter|essential). **Nic can generate LIVE keys directly — NOT waiting on Victor.** He's been in the correct (tenant.checkr.com) console the whole time; currently has TEST keys, which are all we need to build/test on.
- **Checkr Tenant orders REQUIRE a rental property** (hard fail in code) — that's why speculative falls back to `mock`. **Solution (Nic's, adopted): a GAM-owned shell landlord + shell property** anchors speculative checks so a real Checkr Tenant order can run, then auto-migrates to pool. Reuses the existing integration (no 2nd Checkr), needs **no schema change** to background_checks (every pool check is "targeted" at the shell). Shell also **doubles as a dogfooding landlord login**.
- **Applicant pays** for the pool check (their own **portable** report — Nic agrees the portable-report framing sidesteps state application-fee caps, which target *landlord* app fees). Landlord-linked (targeted) flow stays landlord-pays (S561) — leave it.
- **FCRA posture — GAM stays a CONDUIT, not a CRA.** Never derive/show a GAM score or "approved" verdict to landlords (that = becoming a CRA; also breaks the existing `gam_internal_only` credit-ledger firewall; the intake `risk_score` is FRAUD-only anyway). Landlords see **neutral status only** ("completed screening on file" + self-attested facts), never the raw report or a verdict. Report flows **applicant→landlord** via **standing pre-authorization** the applicant gives at intake (consumer-authorized disclosure — the portable-screening model). GAM's paid product is the **$1 lead**, never the report. **Pool membership keyed to INTENT ("looking + has a check"), NOT outcome** — don't let "in the pool" imply "passed," or it becomes an implicit GAM verdict.
- **Share pre-authorization is MANDATORY + affirmative** on the pool flow (a required "Confirm & Share to continue" click — NOT a pre-checked/skippable box; affirmative click = *stronger* FCRA consent), shown **up front before payment/check**. Pool-flow only (targeted flow unchanged; opting out = just apply to a specific landlord). Reuses `consent_pool` + `consent_signed_at` + `consent_ip`.
- **Intake requires a platform profile first** (inline account creation = the sign-up; public entry points but PII only collected post-account, honoring [[gam-nothing-public-rule]]). **Gated portal:** a pool-applicant account shows ONLY the screening steps until assigned+completed — someone who signs up and never finishes sees a portal with nothing but "finish your background check."
- **Public entry points:** "Get screened" CTA on the tenant-portal landing (alt to sign-up/login), a marketing-site CTA, and a **QR code** — all deep-link to the one intake surface.

### BUILT tonight (uncommitted, typecheck-clean, verified)
1. **Migration `20260728160000_add_is_system_to_landlords.sql`** — `landlords.is_system` flag (applied + verified). Marks GAM system entities; exclude from aggregate landlord/revenue reporting.
2. **`scripts/createPoolIntakeShell.ts`** — idempotent; created + verified the shell:
   - user `0437ac9b-31fe-4127-b0bf-8fa3b17b9c4a` = `pool-intake@gam.internal` / `poolshell1234` (rename at will)
   - landlord `a73e74bc-6318-45cc-ab5d-a8a45d915a90` (is_system=true, background_provider=**mock**)
   - property `bc5dc6e8-74c9-41e8-8cc9-dd4acd35c260` (placeholder addr: 1 Renter Pool Way, Phoenix AZ 85001)
   - GOTCHA: run standalone scripts from **`apps/api` cwd** (`node -r ts-node/register src/scripts/...`) — from repo root ts-node picks the wrong tsconfig → ESM dir-import errors.
3. **`services/poolIntake.ts`** — `getPoolIntakeShell()` + `isPoolIntakeLandlord()` (resolve the shell by stable email; un-cached so a provider flip needs no restart).
4. **Intake route → shell** (`background.ts /submit`) — DONE. Speculative (no landlordId) now resolves the shell via `getPoolIntakeShell()` → `effectiveLandlordId` + shell provider; the existing checkr property-resolution auto-picks the shell property (falls back to landlord's first property). No `screening_fee_accruals` to the shell (that guard already keys off the *body* landlordId, falsy when speculative). Typecheck-clean.
5. **Auto-pool trigger** (webhook + dev-mock, both occurrences) — DONE. `!check.landlord_id` → `(!check.landlord_id || await isPoolIntakeLandlord(check.landlord_id))`. Verified `isPoolEligible`/`upsertPoolEntry` make NO landlord assumptions, so shell checks flow into `application_pool` correctly. **26 focused background tests green.**

### ALSO BUILT this session (uncommitted, typecheck-clean, 30 bg tests green)
6. **Server applicant payment (pool flow)** — DONE. `POST /background/payment-intent` now mints a real PaymentIntent for the **speculative** route (landlord route still waived), using new `screeningIntakeFee()` helper: **screening $37.94 + gamFee $5 + tax $0 + processing $1.66 = $44.60** (processing via shared `PROCESSING_FEES`; tax is a real separate $0-default line — sits on screening+gamFee only, processing untaxed). `/submit` now REQUIRES + `verifyPaymentIntent`s the intake PI for speculative and stores it (`applicant_payment_intent_id`). Mock-PI fallback for dev. `crypto` + `PROCESSING_FEES` imported.
7. **Checkr package locked to `essential`** — DONE. `backgroundProvider.ts` was defaulting to `'starter'` (env unset); hardcoded `'essential'` per Nic ("one check platform-wide, API-steered, no landlord discrimination"). Not env/landlord-configurable.
8. **Login "Get screened" CTA** — DONE + browser-verified. Public card below tenant sign-in → `/background-check` (no landlordId = pool). `/background-check` was already outside the auth gate.
9. **Consent step → mandatory pool share-auth** — DONE. `isSpeculative = !priceLandlordId`; when speculative the share-authorization is **required + bold** ("Share my screening with landlords (required)… I confirm this to process my check"), gates Continue (`canNext[4]`), wrong "pay nothing" line removed.

### REMAINING build (in order)
10. **CLIENT card step** (`BackgroundCheckPage.tsx` step 5, "Review & Submit"). Currently hardcodes "landlord covers the cost" + auto-sets `paid`. For **speculative** only: render the $44.60 itemized breakdown + a Stripe **Elements card form** and `stripe.confirmPayment` (mirror `payShared.tsx`'s `<Elements options={{clientSecret}}>`+`<PaymentElement/>` — but `confirmPayment` not `confirmSetup`; `VITE_STRIPE_PUBLISHABLE_KEY` gates it). `/payment-intent` already returns `clientSecret`+`breakdown` for speculative. On success set `paymentIntentId`+`paid`. The step-5 account-creation effect is ~lines 234-291; `submitMut` already sends `applicantPaymentIntentId`. Targeted route: leave as-is (waived).
11. **Gated portal** — a pool-applicant account shows ONLY the screening steps until assigned+complete (Layout/DefaultPage conditional in `apps/tenant/src/main.tsx`).
12. **Public entry points (remaining):** marketing-site CTA + QR → the intake URL (login CTA done).
13. **Checkr live wiring** — `.env` has TEST keys (`ckr_sk_test_…` + webhook secret). Nic self-generates LIVE when ready. Sandbox-test now: flip shell `background_provider` mock→checkr (`UPDATE landlords SET background_provider='checkr' WHERE id='a73e74bc-…'`). Left on **mock**.
14. **Neutral-status pool display + admin backside assignment** (net-new admin endpoint + UI; landlord self-serve $1 unlock already exists).
15. **is_system exclusion sweep** — apply the flag to aggregate surfaces (revenue report + landlord counts at minimum).
16. **Dedicated speculative→shell + applicant-pay e2e test.**

### NIC ACTION ITEMS (bookkeeping/compliance — not code)
- **Resale certificate w/ Checkr:** Nic has NO resale certs on file. Open question (awaiting Checkr's email): does Checkr need a resale cert from GAM to stop charging GAM sales tax, or do they just year-end report GAM's volume? Resale cert is the mechanism that prevents double-tax (GAM pays Checkr $0 tax, collects tax from the applicant once at the final sale). Bookkeeping action.
- **Screening-service sales tax determination (tax pro):** which states tax info/screening services + where GAM has economic nexus. Feeds a per-state screening-tax catalog (same hard-compliance pattern as deposit-interest / tax-form catalogs). Until then `tax=0`. Tax base = screening price only (NOT the markup, NOT processing).

## Sales-tax + nexus workstream (S564 — research done, build pending)
Nic: **no CPA for a while**, so GAM researches the laws itself + wires it, marked
`research` until a pro confirms. Per-state verdicts (research grade — reconfirm the
non-$0 rows before collecting; the exact rates go into the catalog seed when built):

| States | Screening taxable? | Rate | Verdict | Conf |
|--------|--------------------|------|---------|------|
| AZ, UT, NV + most "services-exempt-unless-listed" states | No — screening not an enumerated taxable service | — | **$0** | High |
| OR, MT, NH, DE | No sales tax at all | — | **$0** | High |
| TX | Yes — "credit-reporting service" (report on creditworthiness); or info service at 80% base | 6.25% + local | **Taxable** | Med |
| SD | Yes — info + employment services explicitly listed | 4.2% + local | **Taxable** (nexus-gated) | Med-High |
| HI | Yes — GET reaches ~all services | 4–4.5% | **Taxable** (nexus-gated) | Med-High |
| NM | Likely — GRT taxes most services | ~5–9% | **Taxable** (nexus-gated) | Med |
| OH | Likely NO for pool route — taxes info services only "for business use" + **exempts FCRA-CRA credit reports** | — | **Likely $0 (pool)** | Med |
| CT, DC, WV | Info-services taxers — unchecked | — | **Needs determination** | Low |
- **THE load-bearing nuance:** our pool charge = an *individual* buying their *own
  FCRA consumer report* for *personal* use — generally FAVORABLE (many info-services
  taxes are business-use-only or exempt FCRA reports). Also makes determinations
  complex → real no-CPA risk on the non-$0 states.
- **UX decision (Nic):** when tax = $0, **hide the tax line** on the receipt but
  always keep the field in the data (clean receipts, complete books).
- **Design APPROVED by Nic — two-layer catalog + registration gate:**
  `state_screening_tax_rates` (state, effective_year, taxable, rate_pct, basis,
  status research|confirmed, source, notes) + a **`registered`** flag per state.
  **Collected tax = rate × base ONLY IF registered.** Registered nowhere yet →
  collects $0 everywhere today, zero risk. `screeningIntakeFee(applicantState)`
  looks it up. TO BUILD: catalog table + 50-state seed + wire the helper.
- **Nexus monitor (Nic wants it, mockup shown + approved-direction):** admin-portal
  dashboard — big alert cards (crossed / approaching / registered) + per-state bars
  toward each state's economic-nexus threshold (green→amber→red, warn line
  configurable ~80%). THREE pieces: (1) per-state nexus-threshold catalog ($/txn
  limits, ~$100k/200txn typical, CA/TX/NY $500k — note many states DROPPED the
  txn-count test), (2) nightly tally, (3) the dashboard. Crossing flips the
  `registered` gate the tax catalog reads.
  - **⚠️ TWO SEPARATE CONCEPTS — keep them apart in code:**
    - **Nexus MONITORING (trigger) — Nic's decision S564: count ALL of GAM's OWN
      revenue, conservatively, to register EARLY.** Includes **platform fee +
      screening + every Flex product fee** (FlexPay, FlexDeposit, all Flex),
      attributed by CUSTOMER state — *even lines that may be non-taxable*. Rationale:
      registering early is harmless ($0/small returns); registering late = back-tax
      + penalties. Over-counting the trigger never over-charges anyone.
    - **Tax COLLECTION (charge) — stays narrow + accurate:** only actually-taxable
      sales, only in REGISTERED states, per `state_screening_tax_rates`. This is what
      applicants are charged. Legally-required minimum that counts = screening
      (+ platform fee where a state taxes SaaS, ~20 states — needs a SaaS-taxability
      map).
    - **Still excluded from the tally entirely** (not GAM's revenue): rent (landlord's
      lease — pass-through), landlord **POS sales** e.g. propane (LANDLORD's sale —
      GAM is a Square/Clover-style POS provider, NOT a "marketplace facilitator";
      MPF needs a multi-seller marketplace + payment-processor carve-out applies),
      landlord **payouts** (money movement). ⚠️ If GAM ever builds a true
      multi-seller marketplace, MPF rules WOULD pull third-party sales onto GAM's
      books — revisit then.
  - **Admin dashboard = GAM dark/gold theme** (mockup was on neutral palette; real
    one uses --gold/--bg0 etc. like the rest of admin).
  - Long-term a tax-calc service (Avalara/TaxJar) may replace the hand-kept catalogs.

### QUESTIONS — Nic's answers (received end of S564)
- **Q1 `.env`/Checkr — ANSWERED.** OK to read .env. Keys are TEST (`ckr_sk_test_…`), not live; Nic sets live keys when needed. Confirmed in file.
- **Q2 Applicant payment — ANSWERED: applicant pays.** STILL OPEN = the exact amount/markup the applicant pays for their portable pool check (targeted flow = Checkr cost $37.94 + $5 margin; pool applicant pays their own — same base + what markup?). Ask before wiring item 6.
- **Q3 Shell property — Nic will provide.** "I will think of a shell property." Current placeholder (1 Renter Pool Way, Phoenix AZ). Swap in Nic's real shell property when he gives it (also covers Q5 naming).
- **Q4 Counsel — ANSWERED: skip. "No counsel, just do the design."** Build the conduit/neutral-status/pre-auth design as specified; no counsel-pass gate.
- **Q5 Shell identity — folds into Q3** (Nic thinking of the shell property/name). Defaults stand until then: `pool-intake@gam.internal` / `poolshell1234` / "GAM Renter Pool".

## Launch state (unchanged from S563)
Only launch-blocker remains **live Stripe cutover** (C4 live-fire + C5 prod walkthrough) + Nic's data entry (N2/N3/N4). All money code complete+tested. S563's 17-file batch (pay-in-full, auto-renew, FlexPay $25) still UNCOMMITTED alongside tonight's work.
