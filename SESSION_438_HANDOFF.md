# Session 438 — closed

## Theme

**Fifteenth services-audit session. Triplet sweep of
small uncovered helpers: `systemFeatures.ts` +
`leaseFeesSync.ts` + `connectPayouts.ts`. 23 tests
in one file pinning feature-flag CRUD, the S195
security-deposit lease-fees sync (with the S360
is_refundable hardcode), and the S113-Phase3 Stripe
Payouts engine (firePayout + balance helpers).**

Suite at S437 close: **2358 / 135 files**.
Suite at S438 close: **2382 / 136 files** (+24 cases,
+1 file). 0 failures. Runtime **66.28s**.
Forty-second consecutive fully-green full-suite run.

Zero tsc regressions.

## What shipped

### `services/s438Triplet.test.ts` — 23 cases

Three small services covered end-to-end in one file
with shared mock setup. Stripe is mocked at the
`lib/stripe` module boundary via `vi.hoisted`.

**`systemFeatures.ts` (6)**
- `isFeatureEnabled`: missing key → false (short-circuit,
  no "not found" error)
- `isFeatureEnabled`: enabled=FALSE → false
- `isFeatureEnabled`: enabled=TRUE → true
- `listFeatures`: returns rows ordered by key (verified
  with shuffled input)
- `setFeatureEnabled`: flips enabled + stamps
  updated_by_user_id
- `setFeatureEnabled`: unknown key → noop (UPDATE
  matches 0; no throw)

**`leaseFeesSync.ts` (6)**
- amount > 0 → inserts `security_deposit` / `move_in`
  row with is_refundable=TRUE (the S360 NOT NULL fix)
- amount = 0 → removes any existing row (landlord
  cleared deposit)
- amount < 0 → also removes (treated as "no deposit")
- DELETE-then-INSERT pattern: amount change overwrites
  prior row; no duplicates
- Only touches `security_deposit` + `move_in` rows;
  unrelated `cleaning_fee` / `move_out` rows preserved
- Works with a transactional client arg (writes via
  the passed client — verified by ROLLBACK clearing
  the row)

**`connectPayouts.ts` (11)**

firePayoutForConnectAccount (5):
- amount ≤ 0 → 400 ("must be positive")
- missing idempotencyKey → 400 ("idempotencyKey is required")
- Happy: cents conversion + stripeAccount +
  idempotencyKey; method defaults to 'standard'
- method='instant' pass-through
- description + metadata included when present;
  omitted when absent

getConnectBalance + USD helpers (6):
- getConnectBalance maps cents → dollars for all three
  buckets (available / pending / instant_available)
- Missing instant_available defaults to []
- getAvailableUsdBalance: returns USD amount in dollars
- getAvailableUsdBalance: no USD bucket → 0
- getInstantAvailableUsdBalance: returns USD instant
  amount in dollars
- getInstantAvailableUsdBalance: no USD bucket → 0

## Items shipped

```
apps/api/src/services/
  s438Triplet.test.ts                   (NEW — 23 cases)
```

No source code changes. All three services preserved
as-is.

## Decisions made during build

| Question | Decision |
|---|---|
| Triplet in one file or three separate files? | **One file (`s438Triplet.test.ts`).** Three tiny services share the same `vi.mock('../lib/stripe')` setup; splitting would mean repeating the mock harness three times. The S428 (pdfStamp + pm + landlordPassthrough) triplet used separate files, but those each had distinct mock surfaces. Here the only Stripe-touching one is connectPayouts; combining is cheaper. |
| Pin the S360 `is_refundable=TRUE` hardcode? | **Yes — load-bearing fix.** Per the source comment: pre-S360 the INSERT omitted is_refundable, crashing every CSV-tenant commit that had a security_deposit > 0. The hardcode IS the fix; a regression that dropped the column from the INSERT would re-break the CSV import path. |
| Pin the unrelated-fee preservation? | **Yes — important scope boundary.** A regression that broadened the DELETE filter (e.g., dropped `fee_type='security_deposit'` to "all move_in") would silently nuke cleaning fees + admin fees on every deposit edit. |
| Pin the transactional-client write-through? | **Yes — composability contract.** Multiple callers (lease creation, lease patch, CSV import) wrap syncSecurityDepositLeaseFee inside a larger transaction; a regression that writes via the global pool would commit the sync independently of the surrounding rollback. The ROLLBACK-clears-row test catches that. |
| Pin every Stripe payout-shape field? | **Yes.** stripeAccount + idempotencyKey go through the options arg (not the create args). A regression that put them on the create args would silently mis-route payouts. Verified with `expect.objectContaining` on the options arg. |
| Pin the missing-instant_available default? | **Yes — Stripe inconsistency.** New Connect accounts often return balance objects without the instant_available key. The `?? []` is the guard; without it, the dollar-mapping `.map()` would crash on undefined. |

## Verification

- `npx tsc --noEmit` clean on apps/api (0 errors).
- `npm test` in apps/api: **2382 tests across 136
  files, 0 failures**, 66.28s. **Forty-second
  consecutive fully-green full-suite run.**
- 23 new test cases.
- 0 production regressions.
- 0 new findings — all three services match contracts.

## Services audit — progress

Post-S438:

### Direct coverage — 46 services with .test.ts files

Pre-S438: 43 services covered.
S438: + systemFeatures + leaseFeesSync + connectPayouts.
Now: **46 of 46+ services touched**.

### Still UNCOVERED (~10 files post-S438)

Highest-value continuation candidates:
1. **otp.ts Stripe state-machine half** (S427
   continuation — disbursement firing, OTP success/
   failure path)
2. **flexpay.ts Stripe state-machine half** (S431
   continuation — advance firing, pull-day processing,
   NSF handling)
3. **flexCharge.ts billing/reconciliation half** (S425
   continuation — monthly statement generation, interest
   accrual, payment posting)
4. **DB-backed credit-ledger wrappers** (S429
   continuation — `creditLedgerEmitters.ts`, 900 lines)
5. **Remaining smaller helpers**: maintenanceRequests
   (92), taxForms (138), posTax (208), posTerminal (291),
   depositInterest (352), backgroundProvider (359),
   depositPortability (379), subleaseDocuments (388),
   email (854)

(otpScheduler.ts is DISABLED per file header — units.tenant_id removed in S26; skip.)

## Items deferred — what S439 could target

### Continue services audit

**Recommend S439 = another triplet sweep** through
the next 3 smallest: `maintenanceRequests.ts` (92) +
`taxForms.ts` (138) + `posTax.ts` (208). Maintains
the long-tail cadence.

**Alternatives:**
- otp.ts Stripe state-machine half (heavy single)
- flexpay.ts Stripe state-machine half (heavy single)
- flexCharge.ts billing half (heavy single)
- creditLedgerEmitters.ts (900 lines — would span 2 sessions)

### Validation-hygiene backlog (16 items)

Unchanged from S427.

### Cumulative bug-sweep totals (post-S438)

- **47 production bug fixes** (S438 is direct coverage
  of well-built helpers)
- 16 architectural / validation findings remaining
- 2382 tests across 136 files
- Suite baseline: **60-66s on a clean machine**

## What S439 should target

**Recommended: triplet sweep through
maintenanceRequests + taxForms + posTax.** Continues
the long-tail close-out cadence.

**Alternatives:**
- otp.ts Stripe state-machine half
- flexpay.ts Stripe state-machine half
- flexCharge billing half
- Start creditLedgerEmitters.ts multi-session arc

---

End of S438 handoff. **Small-helper triplet shipped
— 23 tests pinning system feature flags (CRUD +
short-circuit on missing key), the S195
security-deposit lease-fees sync (with the S360
is_refundable hardcode + transactional-client
composability), and the S113-Phase3 Stripe Payouts
engine (firePayout shape + balance helpers).**

2382 tests / 136 files / 0 failures. Forty-second
consecutive fully-green full-suite run.

**47 cumulative production bug fixes shipped across the
bug sweep.** Services audit: 46 services covered; ~10
smaller helpers + Stripe state-machine continuation
halves remain.
