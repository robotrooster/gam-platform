# Session 434 — closed

## Theme

**Eleventh services-audit session. First slice of the
`stripeConnect.ts` multi-session arc — account-
management surface. 24 tests pinning Connect account
creation (user + pm_company), embedded onboarding
sessions, account status fetch, pricing math, and
the webhook readiness-flag recorder.**

Suite at S433 close: **2270 / 131 files**.
Suite at S434 close: **2294 / 132 files** (+24 cases,
+1 file). 0 failures. Runtime **64.60s**.
Thirty-eighth consecutive fully-green full-suite run.

Zero tsc regressions.

## What shipped

### `services/stripeConnect.test.ts` — 24 cases

Five exports covered (out of 12 public). Stripe is
mocked at the `lib/stripe` module boundary via
`vi.hoisted` (necessary because the
`adminNotifications` factory consumes the mock
synchronously at module-init).

**`ensureConnectAccount` — user entity (4)**
- Creates new account; persists `users.stripe_connect_account_id`
- Idempotent: pre-existing connect id returned without a Stripe call
- Stripe call shape: controller config (express dashboard,
  application fees, application losses), US country,
  card_payments + transfers capabilities, manual payout
  schedule, gam_entity + gam_entity_id + caller metadata
- Unknown user → 404

**`ensureConnectAccount` — pm_company entity (3)**
- Creates + persists on `pm_companies.stripe_connect_account_id`;
  business_profile.name = `businessName` arg
- Unknown pm_company → 404
- `businessName` omitted → no `business_profile` key in payload

**`createOnboardingSession` (2)**
- Happy: enables `account_onboarding` component on the Account
  Session + returns `client_secret`
- Stripe returns null client_secret → 500

**`fetchAccountStatus` (2)**
- Extracts charges/payouts/details flags + requirements arrays +
  disabled_reason
- Defaults nullish fields safely (no requirements object)

**`computeApplicationFee` (7)**
- ACH 1% small amount ($100 → $1)
- ACH cap at $6 ($1000 → $6, not $10)
- ACH exact-boundary ($600 → $6)
- US card 3.25% ($100 → $3.25)
- card with null country defaults to base 3.25%
- Non-US (CA) card adds 1.5% surcharge ($100 → $4.75)
- Cents rounding (3.25% of $33.33 → $1.08, not $1.083225)

**`recordAccountUpdated` (6)**
- User with matching account_id → updates connect_charges_enabled
  + connect_payouts_enabled + connect_details_submitted +
  stripe_connect_status_synced_at
- PM company with matching account_id → same readiness fields on
  pm_companies row
- Nullish capability flags default to FALSE on the UPDATE
- No matching row → noop (both UPDATEs match 0; no throw)
- S113-PhaseA: `charges_enabled && details_submitted` → invokes
  passthrough reconcile; no platform_held → no Stripe transfer
- Partial readiness (not `details_submitted`) → reconcile path
  NOT invoked

## Items shipped

```
apps/api/src/services/
  stripeConnect.test.ts                 (NEW — 24 cases)
```

No source code changes. Service preserved as-is.

## Decisions made during build

| Question | Decision |
|---|---|
| Stripe mocks via `vi.hoisted` or const-at-top? | **`vi.hoisted`.** The `adminNotifications` factory references the mock as a property value (eager evaluation at module-init), so it needs hoisting. The lib/stripe factory could work either way (lazy through `getStripe()`), but consistent style is cleaner. Pattern caught + fixed on first run. |
| Pin every controller config field explicitly? | **Yes.** Controller config is the load-bearing S113 architectural decision (`fees: application`, `losses: application`). A regression that changed payer to `'recipient'` would silently flip chargeback liability from GAM to the landlord. The shape-test catches that. |
| Pin the manual payout schedule? | **Yes — S117 architectural decision.** Without `schedule.interval='manual'`, Stripe defaults to daily auto-payouts and GAM loses Friday-batching control. A regression that drops this key would silently break the platform's payout cadence. |
| Pin the S113-PhaseA passthrough reconcile invocation? | **Yes — load-bearing operational hook.** When a landlord finishes onboarding, any rent payments collected while their Connect was incomplete need to be released. The recordAccountUpdated → tryReconcileForLandlordUserId chain IS the unblocker. A regression that drops the dynamic import or the `details_submitted` gate would leave money stuck on the platform balance. |
| Pin computeApplicationFee at the boundary ($600 = exactly $6)? | **Yes.** Math.min boundary tests catch off-by-one regressions. The exact-cap case is the one most likely to flip the wrong direction during refactor. |
| Cover the heavy money-movement surface (rent destination charge, PM transfers, payout/dispute recorders) in this session? | **No — defer to S435+.** Each is a substantial state-machine with multiple branches. Splitting the arc keeps each session under ~30 minutes and avoids fragile mega-files. |

## Verification

- `npx tsc --noEmit` clean on apps/api (0 errors). Caught one
  type-inference issue (`accountsCreateMock.mock.calls[0][0]` on a
  vi.hoisted-typed `vi.fn(async () => ...)` infers `[]` for args);
  fixed with a single `as any[]` cast.
- `npm test` in apps/api: **2294 tests across 132
  files, 0 failures**, 64.60s. **Thirty-eighth
  consecutive fully-green full-suite run.**
- 24 new test cases.
- 0 production regressions.
- 0 new findings — service matches contract.

## Services audit — progress

Post-S434:

### Direct coverage (42 of 43 services ≈ 98%, with stripeConnect partial)

S424: + supersedence
S425: + flexCharge (CRUD half)
S426: + riskScore
S427: + otp (non-Stripe half)
S428: + pdfStamp + pm + landlordPassthrough
S429: + creditScore + creditStats (pure-function half)
S430: + addendumActor + addendumPdf
S431: + flexpay (non-Stripe half)
S432: + utilityBilling
S433: + subleaseAllocation
S434: + stripeConnect (account-management half)

### `stripeConnect.ts` arc progress

Done (S434):
- ensureConnectAccount (both entity types)
- createOnboardingSession
- fetchAccountStatus
- computeApplicationFee
- recordAccountUpdated

Remaining for S435+ (7 functions):
- createRentDestinationCharge
- createRentPlatformCharge
- createPmCompanyTransfer (pure wrapper — small)
- firePmTransfersForReference (medium, ledger-driven)
- recordPayoutEvent (heavy — multi-table writes)
- recordDisputeEvent (medium)
- fireManagerTransfersForReference — **already covered** in
  `stripeConnectTransfers.test.ts` (S400-era)

### Still UNCOVERED (~14 files post-S434)

Highest-value next candidates:
1. **stripeConnect.ts charge helpers** (S435 continuation —
   `createRentDestinationCharge` + `createRentPlatformCharge` +
   `createPmCompanyTransfer` + `firePmTransfersForReference`)
2. **stripeConnect.ts webhook recorders** (S436 continuation —
   `recordPayoutEvent` + `recordDisputeEvent`)
3. **pm.ts invitation lifecycle** (continuation of S428)
4. **flexCharge.ts billing/reconciliation half**
   (continuation of S425)
5. **otp.ts Stripe state-machine half**
   (continuation of S427)
6. **flexpay.ts Stripe state-machine half**
   (continuation of S431)
7. **DB-backed credit-ledger wrappers**
   (continuation of S429)
8. Plus ~7 smaller helpers

## Items deferred — what S435 could target

### Continue services audit

**Recommend S435 = `stripeConnect.ts` charge helpers slice.**
Covers `createRentDestinationCharge` +
`createRentPlatformCharge` + `createPmCompanyTransfer` +
`firePmTransfersForReference`. All four share a coherent
theme (destination-charge money movement) and use the same
Stripe mock setup as S434, so the setup cost is paid once.

**Alternatives:**
- stripeConnect.ts webhook recorders (recordPayoutEvent +
  recordDisputeEvent — could go first if the charge helpers
  feel heavy)
- pm.ts invitation lifecycle (continuation of S428)
- flexCharge.ts billing/reconciliation half
- DB-backed credit-ledger wrappers (continuation of S429)

### Validation-hygiene backlog (16 items)

Unchanged from S427.

### Cumulative bug-sweep totals (post-S434)

- **47 production bug fixes** (S434 is direct coverage of a
  well-built service)
- 16 architectural / validation findings remaining
- 2294 tests across 132 files
- Suite baseline: **60-64s on a clean machine**

## What S435 should target

**Recommended: `stripeConnect.ts` charge helpers** —
continuation of the multi-session arc. Same Stripe mock
setup; covers 4 functions in one slice.

**Alternatives:**
- stripeConnect.ts webhook recorders
- pm.ts invitation lifecycle
- flexCharge billing/reconciliation half

---

End of S434 handoff. **stripeConnect.ts arc opened —
24 tests pinning Connect account creation (express
controller config, application fees + losses,
manual payout schedule), embedded onboarding,
status fetch, pricing formula (ACH cap $6, card
3.25% + Canadian USD surcharge), and S113-PhaseA
readiness-driven passthrough reconcile.**

2294 tests / 132 files / 0 failures. Thirty-eighth
consecutive fully-green full-suite run.

**47 cumulative production bug fixes shipped across the
bug sweep.** Services audit: 42/43 services touched
(stripeConnect partial); 5 of 12 stripeConnect
exports + 1 already-covered = 6/12 done, 6 remain
for S435–S436.
