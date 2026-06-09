# Session 440 — closed

## Theme

**Seventeenth services-audit session. Third triplet
sweep: `posTerminal.ts` + `depositInterest.ts` +
`depositPortability.ts`. 31 tests pinning the
Stripe Terminal reader management + card-present
PaymentIntent shape, the S188/S190 per-state
interest accrual math + idempotency, and the S255
deposit carry-forward state machine with
GAM-escrow vs landlord-held branching.**

Suite at S439 close: **2405 / 137 files**.
Suite at S440 close: **2436 / 138 files** (+31 cases,
+1 file). 0 failures. Runtime **65.98s**.
Forty-fourth consecutive fully-green full-suite run.

Zero tsc regressions.

## What shipped

### `services/s440Triplet.test.ts` — 31 cases

Three medium-sized helpers covered in one file with
shared mock setup. Stripe + adminNotifications mocked
via `vi.hoisted`; production-seeded
state_deposit_interest_rates isolated at
`effective_year=2099`.

**`posTerminal.ts` (10)**
- createConnectionToken: secret returned; fires under
  `stripeAccount` override
- createConnectionToken: missing secret → 500
- registerReader happy: creates Stripe reader + inserts
  pos_terminal_readers row with status='active'
- registerReader: 23505 duplicate → 409
  ("already registered with this landlord")
- listReaders: with propertyId filters; without
  returns all active for the landlord
- archiveReader: happy → status='archived'
- archiveReader: already-archived/wrong landlord → 404
- createCardPresentPaymentIntent: amountCents
  validation (0, neg, non-integer all reject)
- createCardPresentPaymentIntent: shape
  (`payment_method_types: ['card_present']`,
  `capture_method: 'manual'`, metadata with
  gam_purpose / gam_landlord_id / gam_property_id /
  gam_pos_draft_ref, stripeAccount override)
- captureTerminalPaymentIntent: fires under
  stripeAccount override

**`depositInterest.ts` (10)**

resolveRateForLandlord (3):
- Statutory catalog wins when both statutory + override
  present (statutory rate 1.5% beats override 9.99%)
- Override fallback when no statutory row (NJ override
  2.5%)
- Neither source → null

computeMonthlyAccrual (4):
- Not funded → null
- Funded after this month → null
- Disbursed before this month → null
- Full-month happy: principal × rate × (days/365);
  31 days in Jan, 1000 × 0.015 × 31/365 ≈ 1.274
- Partial first month (funded Jan 15): days_held = 17
  (Jan 15 → Jan 31 inclusive)
- principal 0 → null

runMonthlyAccrual + getAccrualHistory (3):
- Happy: accrues + advances
  `security_deposits.interest_accrued`; idempotent
  re-run flips count to skipped (no double-credit)
- Skips deposits whose state has no rate registered
- getAccrualHistory: returns rows ordered by
  accrual_month ASC

**`depositPortability.ts` (8)**
- detectPortabilityEligible: no other lease →
  eligible=false; reason "no other pending/active lease"
- detectPortabilityEligible: has target lease →
  eligible=true; deposit_amount + held_by surfaced
- authorizeDepositPortability happy: status='authorized'
  + signature + IP stored
- authorizeDepositPortability: wrong tenant → 403
  ("Not your deposit")
- authorizeDepositPortability: short signature → 400
  ("Signature required")
- declineDepositPortability: clears authorization
  (status='declined', target/signature/IP nulled)
- executeDepositPortability: gam_escrow →
  status='carried_forward', lease_id + unit_id
  repointed to target, NO admin alert
- executeDepositPortability: landlord-held →
  status='pending_transfer', held_by flipped to
  'gam_escrow' (logical home moves; physical funds
  still elsewhere), admin alert fired
  (category='deposit_portability_pending_transfer')
- executeDepositPortability: not in authorized state
  → 409

## Items shipped

```
apps/api/src/services/
  s440Triplet.test.ts                   (NEW — 31 cases)
```

No source code changes. All three services preserved
as-is.

## Decisions made during build

| Question | Decision |
|---|---|
| Isolate production state_deposit_interest_rates seed via 2099? | **Yes.** Same pattern as S439 taxForms isolation — S188 seeded the real catalog with rates for the current effective year; far-future year keeps tests independent. |
| Pin every Stripe-pass-through shape exhaustively? | **Selectively.** Connection token + register reader + create card-present PI got full shape tests (the metadata is the dispatch key for the webhook handler). capture / cancel / retrieve / processPaymentIntent got one stripeAccount-override pin each — they're identical thin wrappers and individually pinning each would multiply tests without surfacing new contracts. |
| Pin the partial-month days calculation? | **Yes — money math.** The "days from funded → month end inclusive" calculation is the only piece of arithmetic in the accrual engine that isn't a straight multiplication. A boundary regression (off-by-one, wrong include/exclude) compounds across every deposit in every state. |
| Pin the ON CONFLICT idempotency? | **Yes — cron-driven.** The monthly accrual cron is intended to be re-runnable without double-crediting. The `INSERT ... ON CONFLICT DO NOTHING ... RETURNING id` pattern is what makes the re-run a no-op; a regression that switched to `DO UPDATE SET ...` would double-stamp interest. |
| Pin the landlord-held → pending_transfer + admin alert combo? | **Yes — load-bearing operational hook.** Per S255 spec, the landlord-held deposit's physical money is still in the landlord's Connect balance; the alert IS how ops knows to do the reverse-Transfer. A regression that dropped the alert would leave money stuck silently. |
| Pin the held_by flip on portability execute? | **Yes — schema invariant.** The deposit's logical home moves to GAM escrow at carry-forward time regardless of where the physical money is. A regression that left held_by='landlord' would confuse downstream queries (interest accrual, reports). |
| Pin the gam_escrow no-admin-alert path? | **Yes — fan-out boundary.** The gam_escrow path is the happy path; if a regression broadly fired the alert on every portability execution, admins would be flooded with noise for the common case. |

## Verification

- `npx tsc --noEmit` clean on apps/api (0 errors).
- `npm test` in apps/api: **2436 tests across 138
  files, 0 failures**, 65.98s. **Forty-fourth
  consecutive fully-green full-suite run.**
- 31 new test cases.
- 0 production regressions.
- 0 new findings — all three services match contracts.

## Services audit — progress

Post-S440:

### Direct coverage — 52 services with .test.ts files

S438: + systemFeatures + leaseFeesSync + connectPayouts.
S439: + maintenanceRequests + taxForms + posTax.
S440: + posTerminal + depositInterest + depositPortability.

### Still UNCOVERED (~4 files post-S440)

1. **otp.ts Stripe state-machine half** (S427
   continuation)
2. **flexpay.ts Stripe state-machine half** (S431
   continuation)
3. **flexCharge.ts billing/reconciliation half** (S425
   continuation)
4. **creditLedgerEmitters.ts** (900 lines —
   multi-session)
5. **Remaining smaller helpers**: backgroundProvider
   (359), subleaseDocuments (388), email (854)

(otpScheduler.ts is DISABLED per file header — skip.)

## Items deferred — what S441 could target

### Continue services audit

**Recommend S441 = `backgroundProvider.ts` +
`subleaseDocuments.ts` triplet** with one of the
state-machine continuation halves if time permits.
`backgroundProvider` is the Checkr provider wiring
(per S420-S423 arc); `subleaseDocuments` handles the
sublease document storage / signature flow.

**Alternatives:**
- otp.ts Stripe state-machine half (heavy single)
- flexpay.ts Stripe state-machine half (heavy single)
- flexCharge.ts billing half (heavy single)
- Start creditLedgerEmitters.ts multi-session arc
- email.ts (854 lines) — biggest single uncovered
  helper

### Validation-hygiene backlog (16 items)

Unchanged from S427.

### Cumulative bug-sweep totals (post-S440)

- **47 production bug fixes** + 1 documented finding
  (posTax rounding mismatch from S439, still pending
  Nic decision)
- 16 architectural / validation findings remaining
- 2436 tests across 138 files
- Suite baseline: **60-66s on a clean machine**

## What S441 should target

**Recommended: triplet sweep continuing
backgroundProvider + subleaseDocuments + one Stripe
state-machine half.** Maintains close-out cadence.

**Alternatives:**
- Stand-alone otp.ts Stripe state-machine half
- Stand-alone flexpay.ts Stripe state-machine half
- Start creditLedgerEmitters.ts multi-session arc
- email.ts (single, largest remaining)

---

End of S440 handoff. **Triplet shipped — 31 tests
pinning Stripe Terminal reader management +
card-present PaymentIntent shape, the S188/S190
per-state interest accrual with partial-month math
+ ON CONFLICT idempotency, and the S255 deposit
carry-forward state machine with gam_escrow vs
landlord-held branching + admin-alert fan-out.**

2436 tests / 138 files / 0 failures. Forty-fourth
consecutive fully-green full-suite run.

**47 cumulative production bug fixes** + 1 documented
finding still pending Nic review. Services audit:
52 services covered; 4 service files + 3 smaller
helpers remain.
