# Session 433 — closed

## Theme

**Tenth services-audit session. Single-service slice:
`subleaseAllocation.ts`. 22 tests pinning the
sublessor-credit accrual hook (S247) and the
withdraw flow with greedy multi-sublease drain +
Stripe Transfer rollback.**

Suite at S432 close: **2248 / 130 files**.
Suite at S433 close: **2270 / 131 files** (+22 cases,
+1 file). 0 failures. Runtime **64.11s**.
Thirty-seventh consecutive fully-green full-suite run.

Zero tsc regressions.

## What shipped

### `services/subleaseAllocation.test.ts` — 22 cases

Three public functions covered end-to-end with real
DB seeds + a mocked `getStripe().transfers.create`.

**`creditSublessorMarkupForPayment` — short-circuit (7)**
- Payment not found → silently returns
- `payment.type != 'rent'` → no accrual
- No matching sublease (different unit) → no accrual
- Sublease status not 'active' (terminated) → no match
- Payment due_date BEFORE sublease.start_date → no match
- Payment due_date AFTER sublease.end_date → no match
- Markup ≤ 0 (sub == master, full pass-through) → no accrual

**`creditSublessorMarkupForPayment` — happy + idempotency (3)**
- Credits `sub - master` markup; stamps
  `payments.sublease_credit_applied=TRUE`
- Idempotent: same payment fired twice yields one accrual
  (FOR UPDATE lock + early-return on
  `sublease_credit_applied`)
- Two distinct payments accumulate via the
  `ON CONFLICT (sublease_id) DO UPDATE` upsert path

**`getSublessorCredit` (3)**
- Unknown tenant → zeros + empty per_sublease
- Single balance → joins property/unit + reflects fields
- Rounds total_balance to 2 dp (decimal-string in DB →
  number with potential drift; round at view layer)

**`withdrawSublessorCredit` — input/connect gates (6)**
- amount = 0 → 400 ("positive number")
- amount = NaN → 400
- Tenant not found → 404
- No Connect account → 409 ("Set up payouts first")
- Connect account but `connect_payouts_enabled=FALSE`
  → 409 ("not yet enabled")
- Requested > total balance → 400 ("exceeds available")

**`withdrawSublessorCredit` — happy + rollback (3)**
- Single-balance drain: fires Transfer (cents, USD,
  destination Connect, metadata) with idempotencyKey;
  decrements balance + increments total_withdrawn
- Multi-sublease greedy drain (higher balance first):
  500 + 100 with withdraw 550 → first goes to 0,
  second drops to 50
- Stripe Transfer rejection rolls back the balance
  decrements (BEGIN/COMMIT pattern is the rollback
  guarantee)

## Items shipped

```
apps/api/src/services/
  subleaseAllocation.test.ts            (NEW — 22 cases)
```

No source code changes. Service preserved as-is.

## Decisions made during build

| Question | Decision |
|---|---|
| Mock Stripe via `vi.mock('../lib/stripe')` or hit a fake-stripe HTTP? | **`vi.mock`.** Same pattern as `achRetry.test.ts` (S400-series). Replace the `getStripe()` factory at the module boundary; deterministic; no network. |
| Pin every short-circuit branch in the accrual hook individually? | **Yes.** Each is a discrete contract that prevents over-billing or under-billing. The "due_date before start_date" and "after end_date" cases especially — those are the time-bound enforcement. |
| Pin the idempotency contract on the accrual hook? | **Yes.** The S247 source comment calls it out: "a single payments row produces at most one sublessor_credit_balances accrual." A regression that removed the FOR UPDATE lock would double-credit on webhook retries. |
| Pin the ON CONFLICT upsert path for accumulating credits? | **Yes — distinct contract from idempotency.** Two different payments (different `due_date`) must accumulate; one payment fired twice must not. The pair of tests pins both. |
| Pin the rollback on Stripe Transfer failure? | **Yes — critical money-movement safety.** If the BEGIN/COMMIT pattern got broken (e.g., commit before transfer.create), a network blip would decrement the balance without firing the Transfer. The rollback test catches that regression. |
| Pin the greedy-drain order? | **Yes.** The "ORDER BY balance DESC, updated_at ASC" is the intended fairness rule. A regression that switched to a different drain order (e.g., FIFO by created_at) would change which sublease bears the partial-drain remainder. |
| Pin the rounding-to-2dp in `getSublessorCredit`? | **Yes.** Numeric(10,2) is exact at the DB but `Number()` conversion can drift; the view-layer round is the user-facing precision guarantee. |

## Verification

- `npx tsc --noEmit` clean on apps/api (0 errors).
- `npm test` in apps/api: **2270 tests across 131
  files, 0 failures**, 64.11s. **Thirty-seventh
  consecutive fully-green full-suite run.**
- 22 new test cases.
- 0 production regressions.
- 0 new findings — service matches contract.

## Services audit — progress

Post-S433:

### Direct coverage (42 of 43 services ≈ 98%)

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

### Still UNCOVERED (~15 files)

Highest-value candidates next:
1. **`stripeConnect.ts`** (huge, multi-session)
2. **pm.ts invitation lifecycle** (continuation of S428)
3. **flexCharge.ts billing/reconciliation half**
   (continuation of S425)
4. **otp.ts Stripe state-machine half**
   (continuation of S427)
5. **flexpay.ts Stripe state-machine half**
   (continuation of S431)
6. **DB-backed credit-ledger wrappers**
   (continuation of S429)
7. Plus ~9 smaller helpers (each less than ~150 lines)

## Items deferred — what S434 could target

### Continue services audit

**Recommend S434 = start `stripeConnect.ts`
multi-session arc.** It's the single biggest
uncovered service and underpins the entire post-S113
money-movement layer. The first session can cover
account creation + onboarding link generation;
follow-ons can chip into Connect transfers,
charge-level routing, payout management.

**Alternatives:**
- pm.ts invitation lifecycle (continuation of S428)
- flexCharge.ts billing/reconciliation half
- DB-backed credit-ledger wrappers (continuation of S429)
- Roll through smaller helpers (faster cadence,
  less leverage)

### Validation-hygiene backlog (16 items)

Unchanged from S427.

### Cumulative bug-sweep totals (post-S433)

- **47 production bug fixes** (S433 is direct
  coverage of a well-built service)
- 16 architectural / validation findings remaining
- 2270 tests across 131 files
- Suite baseline: **60-64s on a clean machine**

## What S434 should target

**Recommended: start `stripeConnect.ts` arc** — biggest
uncovered service, underpins all post-S113 money
movement. First session covers account creation +
onboarding link generation.

**Alternatives:**
- pm.ts invitation lifecycle
- flexCharge billing/reconciliation half
- Roll through smaller helpers (faster cadence)

---

End of S433 handoff. **Sublease allocation slice
shipped — 22 tests pinning the S247 accrual hook
across all 7 short-circuit branches plus the
withdraw flow with greedy multi-sublease drain and
Stripe Transfer rollback safety.**

2270 tests / 131 files / 0 failures. Thirty-seventh
consecutive fully-green full-suite run.

**47 cumulative production bug fixes shipped across the
bug sweep.** Services audit: 42/43 covered (≈98%);
15 files remain (`stripeConnect.ts` is the marquee
remaining target + smaller helpers + Stripe
state-machine continuation halves).
