# SESSION 512 HANDOFF

Long session. Three arcs: (A) finished three Landlord walkthrough items, (B) a launch
triage that hid all non-launch features across the three launch apps, and (C) a large
legal-terms rewrite (landlord Participation Agreement + tenant Consumer ToS) driven by Nic
decision-by-decision. All work uncommitted (Nic decides commits). No migrations this session.

---

## A. Landlord walkthrough items shipped (#15, #20, #30)

- **#15 Move-in pics (finish).** New `GET /api/leases/:id/move-in-photos` (leases.ts) returns
  the unit's move-in inspection photos (lease-linked first, falls back to unit's latest
  move_in; ignores cancelled/move_out). Auth mirrors /pdf. New `MoveInPhotosSection` +
  `AuthedImg` in `apps/landlord/src/pages/LeaseFormModal.tsx` (photo route is bearer-gated, so
  AuthedImg blob-fetches with the token — a plain <img src> 401s). 6 endpoint tests, 57 leases
  tests green. Verified live vs dev DB. Tracker #15 → [x].
- **#20 Clickable monthly P&L.** New `GET /api/reports/monthly-pl?year=&month=` (reports.ts):
  gross/expenses/net + actual-payment-date breakdown (settled_at-based). ReportsPage rows are
  clickable → `MonthlyPLModal`. New shared `LAUNCH_PLATFORM_FEE` + `launchPlatformFeeForProperty`
  ($2/occupied unit, $10 min) — NOTE: this still computes the minimum PER PROPERTY; Nic later
  changed the model to per-connected-payout-account (see follow-ups). 7 tests, 34 reports tests
  green. Tracker #20 → [x].
- **#30 Applicant Pool proximity.** Rewrote `GET /api/background/pool/search` to drop the
  income/state/risk filters and sort by administrative proximity to the landlord's properties
  (0 same ZIP · 1 same city+state · 2 same ZIP3 · 3 same state · 4 elsewhere; no lat/lon — that's
  the deferred geocoder). Removed FilterBar, added proximity badge in ApplicantPoolPage. 3 tests.
  Tracker #30 → [x]. (Seeded 4 demo pool entries — cleanable: provider_name='S512-pool-verify'.)
- Demo seed left in dev DB for #15: move-in inspection + 2 placeholder photos on a james lease
  (cleanable: `DELETE FROM unit_inspections WHERE notes='S512 move-in pics verify seed'`).

## B. Launch triage — hide non-launch features (landlord + tenant + POS)

Consulted `~/Downloads/HANDOFF_APPS_PERSONAS.md`. Launch trio = **Landlord, Tenant, POS**;
Business waits. Hidden via a `LAUNCH_HIDDEN` set per app (nav filtered + routes redirect; code
intact, reversible by emptying the set). All three apps `vite build` green.

- **Landlord** (`Layout.tsx` `LAUNCH_HIDDEN` + `main.tsx` route guards): hid FlexCharge, Fitness,
  PM Invitations (+ the PM cards in SettingsPage & PropertyDetailPage), Subleases, Work Trade.
- **Tenant** (`main.tsx` `LAUNCH_HIDDEN`): hid Flex Advantage (/services), My Record (/credit),
  My Disputes, Fitness, and the Flex bits on Home (deposit KPI de-linked, Subscriptions card hidden).
- **POS** (`POSPage.tsx` `LAUNCH_HIDE_CHARGE`): hid the "charge" (FlexCharge) tender; cash/card only.
- **#7 OnboardingPage rewrite** — was a landmine: the landlord Participation Agreement presented the
  OLD advance/OTP model + $15/$5 fees. Rewrote it (see arc C). Also fixed a bank-step banner
  ("until attorney review is complete" → "until live payment processing is enabled").
- **Kept (per Nic):** Master Schedule + Bookings (RV core), Background Checks/Application (Checkr
  unblocks tonight per Nic).
- Inspection photo/video 401 (landlord + tenant) is being fixed in a SEPARATE spawned session Nic
  started off a background chip — do NOT duplicate it here.

## C. Legal terms rewrite (the bulk of the session)

### Landlord Participation Agreement — now 21 sections
Lives in `apps/landlord/src/pages/OnboardingPage.tsx` (the onboarding wizard agreement step).
Browser review copy: `~/Downloads/GAM_Landlord_Participation_Agreement_REVISED.html` (hand-maintained
in parallel; re-open with `open`). Rewrote from the superseded advance/OTP/$15-$5 model. Sections:
1 Payment Processing & Payouts · 2 Payment Routing Priority (GAM-first FIFO, "any current or future
service" forward-compat, not debt collection) · 3 Platform Fees ($2/occupied unit; **$10 min per
connected payout account, not per property**) · 4 Payment Reversals & Pass-Through Charges (GAM bears
NO charge burden; reversals clawed back from recipient) · 5 Additional Services · 6 Security Deposit
Custody (escrow where required, usable where allowed, never impaired, transfer for reduced fee) ·
7 Tenant Screening & FCRA (landlord is FCRA user; GAM sends the §615(a) notice) · 8 Eviction Mode ·
9 ACH Authorization · 10 Tax Reporting · 11 Landlord Compliance & Indemnification · 12 Disclaimers &
Limitation of Liability (cap = trailing-12-mo fees) · 13 Automated Systems & AI Agents (landlord/operator
**must confirm an agent action before it is taken**) · 14 Electronic Records & Signatures · 15
Communications Consent (TCPA) · 16 Privacy & Data · 17 FlexCharge · 18 Termination (leave anytime,
fees NOT prorated, custody deposits retained up to 90 days unless law requires sooner) · 19 Dispute
Resolution & Arbitration (binding individual arb + class-action waiver, small-claims/injunctive carve-outs)
· 20 Governing Law & Amendments · 21 General Provisions. Removed the "pending legal review" framing
throughout. tsc green.

### Tenant Consumer ToS — `legal/CONSUMER_TERMS_OF_SERVICE.md` (the single tenant list)
Nic: one list, fold into the existing Consumer ToS (don't make a separate tenant agreement).
Review copy: `~/Downloads/GAM_Consumer_ToS_REVISED.html` (rebuild: `node_modules/.bin/marked -i
legal/CONSUMER_TERMS_OF_SERVICE.md > /tmp/tos_body.html && python3 /tmp/build_tos_preview.py`).
- **§5.2 fees** — tenant pays both by default; landlord may elect at onboarding to cover **ACH only**;
  **card 3.25% is always the tenant's, never the landlord's**. Fixed stray "deposit financed on your
  behalf" advance line.
- **§9.1 FlexDeposit — rewritten advance → CUSTODY.** No advance, no float to landlord; landlord's
  books show the deposit in full at move-in but GAM holds the cash; $3/mo custody fee; 2-6 installments
  by deposit size (disclosed at enrollment); SSDI/SSI only + income verified; transfers (prior landlord
  gets NOTHING, new operator's books update, tenant tops up to GAM, custody fee dissolves once marked in
  new books); kept the no-credit/no-collections/no-CRA scaffolding. §9.1.1-9.1.8.
- **§9.2 FlexPay** — added SSDI/SSI-only, can't enroll until deposit paid in full, can't change due date
  while a balance is outstanding, retry schedule (2nd next biz day, 3rd on 3rd biz day after due date),
  **failure = all 3 fail → 90-day re-enrollment lockout**.
- **§9.3 FlexCharge** — "organized by GAM, not operated by GAM; GAM sets no rules, only enables it,
  advises operating within local law."
- **§9.4 FlexCredit — rewritten lender → credit-REPORTING** (positive payments via third-party furnisher,
  no warranty of results, opt out anytime, no proration/refund). Fixed §9.5's stale "FlexCredit Lender".
- **§24 Automated Systems & AI Agents** (added; confirm-before-act) · **§25 Communications & Consent to
  Contact** (added; TCPA autodialed/prerecorded consent, STOP opt-out, not a condition of service).

## Key decisions Nic locked this session
- **GAM bears NO charge burden** ("#1 commandment"): all banking/chargeback/return/network charges pass
  through; reversals after payout recovered from the recipient. CLAUDE.md's old "GAM eats chargebacks/
  ACH returns/fraud" line was CORRECTED this session.
- **Fee payer:** tenant pays ACH (1%/$6) + card (3.25%, +1.5% non-US) by default; landlord asked at
  onboarding to cover **ACH only**; landlord **never** covers card.
- **Platform-fee minimum is per connected payout account (entity/bank account), NOT per property.**
- **FlexDeposit = custody, no float.** **FlexCredit = reporting, not a lender.** **FlexCharge organized
  not operated; goes in BOTH tenant ToS and landlord agreement.**
- **Arbitration + class-action waiver:** added to the landlord agreement (Nic said yes).

## Memory written/updated
- `gam-launch-no-advance-no-fee-absorption.md` — added no-charge-burden detail + the per-account fee
  minimum + the fee-payer model.
- `flexsuite-product-rules.md` — NEW: full FlexSuite spec (eligibility, installments, custody no-float,
  retries, lockout, transfers, FlexCharge organized-not-operated). Indexed in MEMORY.md.
- CLAUDE.md corrected (chargeback line).

## Open follow-ups (none launch-blocking; for the morning)
1. **Propagate per-connected-account fee minimum** beyond the agreement: DashboardPage "$10/property"
   copy + the shared `launchPlatformFeeForProperty` helper (still per-property) + the #34 backend fee
   reconciliation (admin income still computes the stale $15/$5).
2. **Onboarding "cover tenant ACH?" toggle** — the landlord terms now say the landlord is asked at
   onboarding to cover ACH; that UI question/toggle isn't built yet. Also lock `card_fee_payer` to tenant.
3. **FlexDeposit code rework** — `services/flexDeposit.ts` still implements the OLD advance/eat-the-gap
   logic; the terms are now custody. Code needs to follow (was flagged in walkthrough #7 / S507).
4. **Inspection media-401 fix** — in a separate spawned session (don't duplicate).
5. Optional: render the ToS into the app's real /terms surface; counsel pass on the deposit "use in
   ordinary course" + 90-day retention + the FlexDeposit custody framing.

## How to resume
- `~/gam-start.sh` for the full boot. Apps + ports per CLAUDE.md. The preview MCP tool's launch config
  is stale (can't see the `landlord` app); I added `landlord` to `.claude/launch.json` but a fresh tool
  session is needed to pick it up. Agreement reviews were done via standalone HTML opened with `open`.
- Both review tabs: `~/Downloads/GAM_Landlord_Participation_Agreement_REVISED.html` and
  `~/Downloads/GAM_Consumer_ToS_REVISED.html`.
- Key tests still green: `cd apps/api && npx vitest run src/routes/leases.test.ts src/routes/reports.test.ts
  src/routes/background-pool-proximity.test.ts`.
