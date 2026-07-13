# SESSION 537 HANDOFF

## Theme
Late-fee consistency architecture (decisions → gate → billing ceiling),
CSV-first onboarding with Nic's REAL Oak Park import, the full FIFO
payment-application stack, payment-race protection, and the W-70
native-dialog sweep. Plus a morning of Safari forensics (ghost window,
not a code bug) and two long-standing silent 404/401 fixes.

## Shipped (all tested; 328+ tests green across ~14 suites)

### 1. Late-fee consistency (Nic-locked, memory: gam-late-fee-consistency)
- **Explicit per-(property, unit_type) DECISIONS**: property_unit_type_late_fees
  rows are now decisions — fee terms OR no_late_fee=TRUE. No row = UNDECIDED.
  Migration 20260712100000 (CHECK decision_shape + grandfather backfill).
- **Gate** (services/lateFeePolicy.ts → assertLateFeeDecision[ForUnit]):
  undecided classes refuse unit-add (units POST), tenant onboarding
  (onboard-tenant, unit-bound pending intents), tenant-CSV commit, and
  PDF-import resolve — 422 with a pointer to the settings surface.
  DELETE of a decision is blocked while units of the class exist.
- **NEVER invent a late fee**: parser $15/5-day fabrication removed
  (resolveIntent + onboard-tenant + CSV commit write NULL when the
  document is silent); leases late_fee column DEFAULTs dropped
  (migration 20260712101000). Document silent = no fee, per lease-is-law.
- **Billing ceiling** (jobs/lateFees.ts): cumulative per-invoice cap —
  billed ≤ min(lease schedule, policyScheduleTotal(current class policy)).
  No policy → nothing bills. Tenant-favorable across mismatched
  types/periods/grace automatically.
- **Payment-race protection**: (a) postmark rule — an in-flight
  ('processing') non-late-fee child suppresses fee generation (ACH takes
  2-4 days; pay by the 5th = on time); failure back-fills the whole
  missed schedule retroactively (correct per Nic's retroactive rule);
  (b) stop-on-paid — accrual stops when every non-late-fee child settles
  (no daily snowball off an unpaid fee). Card+trigger midnight race was
  already safe (invoice status rollup trigger is transactional).
- Per-invoice chains confirmed: N months behind = N independent chains.

### 2. CSV-first onboarding + Oak Park (REAL DATA) import
- Properties-CSV: blank/unrecognized unit_type = BLOCKER (silent
  apartment-default removed at validate AND commit); wizard collects
  late-fee decisions between validate and commit (`lateFeeDecisions`
  commit payload → upsert → final gate assert); PropertyOnboardingPage
  got a Unit Type column (select) + the decision panel.
- Tenant-CSV: validate returns `missingLateFeeDecisions` with a
  MODE-of-file suggested prefill (most frequent (fee, grace) pair among
  the file's leases); TenantOnboardingPage intercepts BEFORE the
  auto-commit fast path, saves decisions via PUT, re-validates, resumes.
- Subtypes LOCK unit type at unit creation (conflicting body.unitType →
  400; subtype wins when body omits it).
- **Oak Park Motel and RV imported live** from Nic's real DoorLoop rent
  roll (~/Downloads/OakParkMotelandRV_Report-Rent-Roll_Alltime-2.xlsx →
  scratchpad CSV): 22658 Highway 89, Yarnell AZ 85362 — 32 units under
  realestaterhoades@gmail.com (21 rv_spot @$440, 8 mobile_home
  $350-400, 3 apartment $900-1000). Policy on all 3 classes: $25 initial
  (day 6, retroactive-to-the-1st encoding), $5/day accrual, 5-day grace,
  no cap. NO tenants imported (deliberate — rent roll has no
  emails/phones; needs DoorLoop People → Tenants export). No tenant
  contact of any kind (emails suppressed in dev + property imports send
  none). Nic may launch with Oak Park as customer #1 — LEAVE IT IN PLACE.
- **Demo checkpoint**: deploy/demo-reset.sh capture|reset;
  deploy/demo-checkpoint.dump (24MB) captured with Oak Park + demo
  portfolio. Reset restores the exact pitch starting state.

### 3. FIFO payment application (Nic-locked, memory: gam-payment-application-fifo)
- Migration 20260712150000: tenant_remittances, remittance_applications,
  lease_prepaid_credits, properties.accept_partial_payments.
- POST /payments/pay-balance: ONE Stripe charge, allocateOldestFirst
  (shared) plans oldest-first application incl. FAILED rows (still
  owed); fully-covered rows share the PI (standard webhook settles them
  ALL — allocation/credit-ledger/supersedence/propane unchanged);
  partial row SPLITS (propane pattern; is_remainder) so "short is
  short" stays truthful; pay-ahead remainder → lease_prepaid_credits at
  webhook settle; invoiceGeneration consumes credits oldest-first when
  creating new charge rows. GET /payments/balance-context feeds the UI.
- Tenant PaymentsPage rebuilt: READ-ONLY oldest-first ledger, single
  Pay Now, any amount (partial/full/ahead) — locked to full balance when
  the property rejects partials (eviction-clock protection;
  PaymentAcceptanceCard toggle on property detail, PATCH
  acceptPartialPayments). Old per-row /payments/:id/pay flow retired
  from the tenant UI (endpoint still exists).
- Late Fee Policy card now takes accrual (+period) and cap inputs
  (PUT late-fee-overrides extended); rows display the full schedule.
- Tests: s537-payment-fifo.test.ts (FIFO order incl. failed-first, split
  math, partial rejection 422, pay-ahead credit → consumed by
  generation) + s537-late-fee-consistency.test.ts (20 tests: gate,
  ceiling, postmark, stop-on-paid, subtype lock, CSV-first, mode
  suggestion).

### 4. W-70 — native dialogs ELIMINATED (walkthrough item closed)
- components/dialogs.tsx in BOTH landlord + tenant apps: toast()/
  toast.error() stack, appConfirm() promise-based modal (danger
  variant), appPrompt() input modal. DialogHost mounted in each layout.
- 44 call sites swept across 18 files (SchedulePage 11, UtilityMeters 7,
  POSPage 6, ESign 4, …). grep shows ZERO native alert/confirm/prompt
  in both portals (comments only). Both apps tsc-clean; SchedulePage
  verified loading with no console errors.

### 5. Small fixes
- Tenant app 401 auto-logout interceptor (was the only portal missing it).
- GET /api/tenants root route (landlord-scoped tenant list) — five
  landlord pages had silently empty pickers off the 404 forever.
- PropertyLateFeeSection alerts → in-app (part of W-70).
- CLAUDE.md demo-credentials note corrected: demo data lives under
  james@demo.dev since S527; realestaterhoades owns only Oak Park now.

### Morning forensics (no code defect)
Nic's "nothing clickable in Safari" = macOS ghost-window (WindowServer
paint/position desync after multi-display sleep). Fixed by
programmatically re-bounding the windows + a Safari restart. The app was
healthy throughout.

## Decisions made (all Nic)
- Late-fee consistency 3-layer rule: draft from policy / bill
  min(lease, policy) / explicit decisions gate onboarding.
- CSV-first onboarding supersedes property-first: the file is the front
  door; the wizard collects decisions pre-commit; gate never relaxes.
- Mode-of-file prefill for decisions (suggested, never auto-applied).
- FIFO oldest-first application, ALWAYS; "short is short" fee
  generation, UNCAPPED default (caps optional per landlord, "maximize
  state law"); tenant never picks payment targets — single Pay Now,
  any amount incl. pay-ahead; partial-reject per property.
- Anti-pyramiding softening REJECTED (tender-based generation off the
  table). NC-style statutes become hard-compliance rows at expansion.
- Oak Park stays in the dev DB as launch candidate #1.
- Build-now-not-later standing rule (memory saved): no deferred lists.

## Files touched (majors)
api: migrations 20260712{100000,101000,150000}; services/lateFeePolicy.ts;
jobs/{lateFees,invoiceGeneration}.ts; jobs/leaseParser/resolveIntent.ts;
routes/{units,landlords,properties,tenants,payments,webhooks}.ts;
test/dbHelpers.ts (+seedLateFeeDecision, withLateFeeDecision, cleanup).
landlord: components/dialogs.tsx(new), layout/Layout.tsx,
PropertyLateFeeSection(+PaymentAcceptanceCard), PropertyDetailPage,
PropertyOnboardingPage, TenantOnboardingPage, + 15 pages (dialog sweep).
tenant: components/dialogs.tsx(new), main.tsx, lib/api.ts,
pages/{PaymentsPage(rebuilt), payShared, LeasePage, SignPage}.
root: deploy/demo-reset.sh(new) + demo-checkpoint.dump, FINAL_WALKTHROUGH.md
(W-70 closed).
tests(new): routes/s537-late-fee-consistency.test.ts,
routes/s537-payment-fifo.test.ts.

## Deferred / next session targets
1. **Oak Park tenants**: needs Nic's DoorLoop People → Tenants export
   (emails/phones); then tenant-CSV import (mode prefill will fire) —
   re-capture the demo checkpoint after.
2. **Nic-gated externals**: Stripe live keys (sales rep) → FlexPay
   flip-on (procedure: SESSION_520_HANDOFF) + hardware tap test + launch
   flips (prod launchd, Vercel Pro); Checkr key → W-48/49/50.
3. **Walkthrough**: W-56 work-trade pass (Nic walks it).
4. Tenant-facing FIFO polish when tenant-portal flow resumes (per-line
   "where every dollar went" from remittance_applications is stored but
   not yet surfaced).
5. If a pitch happens: `bash deploy/demo-reset.sh reset` afterwards.

## Watchouts
- payments/:id/pay endpoint still live (tenant UI no longer calls it;
  utilities pay flow still uses payShared with per-bill endpoints).
- properties.late_fee_* legacy columns remain (drafting/billing ignore
  them since S535/S537; only the master late_fee_enabled toggle matters).
- knip/lint not run this session; tsc clean on api/landlord/tenant.
