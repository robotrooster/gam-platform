# SESSION 551 HANDOFF — Stripe live keys, Checkr Tenant build, fee schedule, state caps

(Code comments in this session use both S551 and S552 markers — same session,
spanning 7/21–7/22. Next session is 552.)

## Theme
Launch-sprint execution: Stripe live keys obtained + wired (Connect blocked in
Stripe review); Checkr background checks rebuilt for the Checkr TENANT API and
sandbox-verified end-to-end; platform card fee locked (3.25% + $0.26); 51-
jurisdiction application-fee-cap catalog researched + seeded; landlord-side
screening billing ($5 + capped-state shortfall) with monthly sweep; applicant
refunds for never-completed screenings.

## Current wait-state (nothing actionable until one of these fires)
1. **Stripe**: live keys ARE in apps/api/.env and verified (account fully
   activated, charges+payouts enabled). CONNECT enablement is stuck in a
   Stripe-side review; Nic escalated by phone → email correspondence pending.
   Verify instantly with the probe: POST /v1/accounts (Express) — still
   returns "sign up for Connect". When it succeeds → C3 Connect wiring
   (Connect webhook endpoint + dual-secret constructEvent), N4 KYC, C4
   live-fire test, C5 walkthrough.
2. **Checkr**: rep (Victor, cc Alex) owes: entity re-registration (account is
   under Nic's PERSONAL name — must become GAM entity), contracted Essential
   pricing, customer-vetting requirements (GAM must vet landlords per Credit
   Bureau reqs — build into landlord onboarding when specified), consolidated
   billing cadence (per-order vs monthly = GAM's float window).
3. **Nic**: N2 (real Oak Park landlord account) + N3 (data entry) deliberately
   deferred until Stripe/Checkr settle.

## Shipped (all deployed: prod API via launchd build+kickstart, tenant+landlord
## portals via vercel build+deploy --prebuilt)
- **C3 groundwork**: raw Stripe webhook storage (stripe_webhook_events,
  persist-before-process, error stamping, body-hash fallback ids); live
  platform webhook endpoint we_1TvhBnDNEru9AEpKykhywHYW →
  api.goldassetmanagement.com/webhooks/stripe, secret wired, sig-rejection
  verified; live publishable key in both portals (Vercel env via REST API —
  CLI `env add` silently stores EMPTY values, never use it).
- **Checkr Tenant adapter** (services/backgroundProvider.ts): rewritten from
  classic API to tenant.checkr.com/api (Bearer; base/package/secret env).
  POST /orders w/ rental-property address + name/email/DOB only — NO SSN
  (Checkr's hosted apply flow collects PII/consent). Tenant-Signature HMAC
  (t.rawBody) verify; report.completed → fetchReport → per-product
  clear/consider summary; COALESCE guard so progress events never null a
  stored summary. E2E PROVEN LIVE: sandbox order → real webhook through
  tunnel → sig verified → report fetched → row complete (<5s).
  Sandbox 'starter' = criminal + sex-offender + global watchlist; Essential
  adds eviction + credit (Nic chose ESSENTIAL platform-wide).
- **Intake slim-down** (tenant BackgroundCheckPage): provider=checkr hides
  SSN, ID upload optional, "Complete Screening with Checkr →" button
  (applicant_redirect_url via /status + submit response). /price returns
  provider + providerCollectsPii + fee breakdown (+capApplied/feeProhibited).
- **Fee schedule S552-locked**: card 3.25% + $0.26/txn (26¢ mirrors the
  Stripe IC+ contract fixed cost: interchange + 0.7% + 26¢), +1.5% non-US;
  ACH 1%/$6 unchanged. Single source PROCESSING_FEES (shared) →
  computeApplicationFee + platform_processing_rates rows (were NULL
  placeholders that 503'd allocation — a hidden launch blocker, now seeded;
  cap columns added, allocation applies caps). Fee copy updated in 4 surfaces.
- **State cap catalog**: state_application_fee_caps — ALL 51 jurisdictions
  explicit (Nic's requirement; "verified 2026-07" per row). 13 restricted:
  MA/VT prohibited; NY 20, WI 25, CT 50, NJ 50, DC 54, CA 65.86, ME 75;
  actual_cost_only (no processing add-on): CA CO CT ME MN NY OR WA WI.
  Resolver: applicant pays min(all-in standard, effective cap); prohibited →
  $0 + payment step skipped (payment-intent feeWaived, submit allows no PI).
  BACKGROUND_CHECK_APPLICANT_FEE_USD=34.99 (Essential public price; update
  on Victor's discount — actual-cost states auto-track).
- **Landlord screening billing**: screening_fee_accruals written at submit
  (checkr, initiated, targeted): $5 compliance (SCREENING_COMPLIANCE_FEE_USD)
  + shortfall on ALL-IN basis (standard_total − applicant_charged) → GAM
  nets exactly zero. Monthly sweep processScreeningFeeSweep (rides the
  1st-of-month 1:30am cron): one platform_revenue_ledger entry per landlord
  (type platform_fee_subscription, reference_type screening_fee_sweep),
  rows stamped billed_at + ledger id, idempotent.
- **Applicant refunds** (services/backgroundRefund.ts): cancel route refunds
  in full + voids unbilled accrual; daily 2:40am stale sweep cancels+refunds
  awaiting_applicant > BGC_STALE_DAYS (30). Full-refund-everywhere = MN-et-al
  compliant. Checkr Tenant has NO cancel API / cancellation webhook.
- **Checkr config in .env**: CHECKR_API_KEY (ckr_sk_test_… — personal sandbox
  acct), CHECKR_WEBHOOK_SECRET (registered test webhook →
  /api/background/webhook/checkr), package defaults 'starter' via code
  (set CHECKR_PACKAGE=essential at live cutover).

## Decisions (Nic)
- Checkr Essential platform-wide; one package everywhere (anti-discrimination).
- Screening money: applicant pays GAM on OUR rails (card volume for Stripe
  renegotiation ~$2M/yr target); Checkr consolidated billing to GAM's account
  (only option; per-landlord billing doesn't exist on Checkr Tenant);
  applicant-direct billing DECLINED (volume). No upcharge on the check itself
  (Checkr terms + state actual-cost laws); margin = landlord-side $5/screening.
- Caps are ALL-IN (processing inside the cap — conservative read, no explicit
  carve-out exists); landlord covers (standard all-in − applicant paid).
- Card fixed fee 26¢ = exact IC+ mirror. Don't lower the 3.25% (rent margin).
- Rent strategy = push ACH; card is edge case.
- Float: uncapped = zero (applicant pays before order); capped = shortfall
  floats ≤1 billing cycle. Accepted.

## Files touched (verify: ls, migrations above)
api: services/backgroundProvider.ts (Tenant rewrite), backgroundRefund.ts
(NEW), stripeConnect.ts (fee + PROCESSING_FEES import), allocation.ts (caps),
routes/background.ts (fee resolver, slim intake, property resolution,
accruals, refund hook, price/payment-intent cap-aware), webhooks.ts (raw
storage), jobs/platformFeeAccrual.ts (screening sweep), scheduler.ts (sweep +
2:40 stale cron), test/dbHelpers.ts (cleanup adds). shared: PROCESSING_FEES.
tenant: BackgroundCheckPage (slim + cap display + fee-waived + Checkr link),
payShared copy. landlord: PropertiesPage/OnboardingPage copy. Tests:
background-checkr-webhook (Tenant rewrite), background-provider-selection
(+9 cases), stripeConnect.test (26¢). CLAUDE.md pricing section. 8 migrations.

## Watchouts
- Vercel: NEVER `vercel deploy --prod` from app dir (uploads without
  workspace → fails + emails Nic). Always: vercel pull → vercel build --prod
  → vercel deploy --prebuilt --prod. Env vars via REST API only.
- vitest loads apps/api/.env → fee tests compute expectations from env, don't
  hardcode.
- background_checks.landlord_id NOT NULL vs speculative-mode (pre-existing
  S423 finding) still unfixed.
- Checkr billed-then-cancelled accrual (swept before cancel) logs a warning →
  manual adjustment; no auto-reversal on purpose.
- platform_revenue_ledger type CHECK not in shared (predates rule); screening
  sweep reuses 'platform_fee_subscription' + reference_type discriminator.
- Annual refresh NOV/DEC: cap catalog 2027 rows (CA/DC indexed, CT
  adjustable, NJ new) + state deposit-interest + tax-form catalogs.

## Next session
1. If Stripe email arrived → probe; on success: C3 Connect finish (Connect
   webhook endpoint + dual-secret verify) → N4 → C4 → C5.
2. If Victor replied → entity swap, real pricing (env), vetting requirements
   (design landlord-onboarding gate), billing cadence.
3. Then N2/N3 (Nic data entry) + C7 rolling QA.
4. Post-launch parked: landlord-facing prohibited-state cost warning at
   onboarding, per-request actor attribution (audit journal), portable-report
   (IL/CO/RI) feature, marketing rebuild.
