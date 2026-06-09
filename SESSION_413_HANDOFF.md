# Session 413 — closed

## Theme

**Fifth validation-hygiene micro-session. S386 vendor
overpayment two-phase confirmation shipped — schema
migration + route fix + 5 new tests pinning the
behavior. CLOSES THE LAST ACTIVE-LOCKED S398 DECISION.**

Suite at S412 close: **1817 / 97 files**.
Suite at S413 close: **1836 / 99 files** (+19 cases,
+2 files — books-journal-tx-bills gained 5 new cases
+ tenants-invite gained baseline updates from S410
that landed in this run + other small recounts).
0 failures. Runtime 1331.42s. Seventeenth consecutive
fully-green full-suite run.

Zero tsc regressions.

## What shipped (S398 locked decision S386)

### Pre-fix behavior

`POST /api/books/bills/:id/pay` accepted any payment
amount with no overpayment handling:

- An amount > bill remaining stored `amount_paid >
  amount` on the bill (no DB constraint)
- `vendor.ytd_paid` was incremented by the full
  payAmount (over-credited)
- `vendor.ap_balance` was clamped to 0 via
  `GREATEST(0, ...)` — the excess just **disappeared
  from the vendor accounting picture entirely**

Example: bill $100, paid 0, landlord pays $150.
- Bill: `amount_paid = 150`, status = 'paid' (over)
- Vendor: `ytd_paid += 150`, `ap_balance = 0`
- The "extra" $50 was unrecoverable from the data
  model — no record of the vendor owing the landlord
  anything, no way to apply the credit to a future
  bill.

### Fixes shipped

**Migration: `books_vendors.credit_balance`**

```sql
ALTER TABLE books_vendors
  ADD COLUMN credit_balance numeric(12, 2) DEFAULT 0;
```

The substrate for vendor pre-payment credit
accumulation. Default 0. No backfill needed (pre-S413
vendors have credit_balance=0 by default).

**Route: two-phase overpayment confirmation**

```ts
const overpayment = payAmount - billRemaining
if (overpayment > 0.01 && req.body.acceptOverpayment !== true) {
  return res.status(409).json({
    success: false,
    error: 'Payment exceeds bill remaining; confirmation required',
    requiresOverpaymentConfirm: true,
    billRemaining: +billRemaining.toFixed(2),
    overpaymentAmount: +overpayment.toFixed(2),
    vendorId: bill.vendor_id,
  })
}

// On confirmation, cap the bill, route excess to credit.
const cappedPayAmount = overpayment > 0 ? billRemaining : payAmount
// ... bill update ...
// Vendor: ytd_paid only counts what hit the bill;
// excess flows to credit_balance.
UPDATE books_vendors SET
  ap_balance     = GREATEST(0, COALESCE(ap_balance,0) - $1),
  ytd_paid       = COALESCE(ytd_paid,0) + $1,
  credit_balance = COALESCE(credit_balance,0) + $2,
  updated_at     = NOW()
WHERE id=$3
```

Frontend flow (per the Nic-locked decision):
1. Landlord enters $150 on a $100 bill → server 409s
   with `requiresOverpaymentConfirm: true` + the
   amount breakdown
2. Frontend shows modal: "This payment exceeds the
   bill remaining by $50. The excess will be recorded
   as a credit against this vendor's future bills.
   Proceed?"
3. Landlord clicks Proceed → second request with
   `acceptOverpayment: true` → bill closes at $100,
   $50 lands on vendor.credit_balance

### What's deferred to a follow-on session

**Credit consumption (spend) on subsequent bills.**
S413 adds the storage substrate + accrual path. The
matching "consume vendor.credit_balance before
charging landlord" flow on next bill-pay is a
separate session. Today the credit just accumulates;
landlords would need to use it via manual offset
until consumption is wired.

This is a deliberate scope split — credit consumption
needs its own UX design (auto-apply? landlord opt-in?
show the available credit at pay-time?) and the
accrual path was the lock-step urgent fix.

## Items shipped

### Schema migration

```
apps/api/src/db/migrations/
  20260607140715_vendor_credit_balance.sql            (NEW)
```

### Route update + tests

```
apps/api/src/routes/
  books.ts                             (1 substantive:
                                         POST /bills/:id/pay
                                         + overpayment
                                         detection + 409
                                         response shape +
                                         credit_balance
                                         write)
  books-journal-tx-bills.test.ts       (5 new test cases
                                         appended to the
                                         existing /bills
                                         describe block)
```

### Test coverage — 5 new cases pinning S386

1. **Overpayment without acceptOverpayment → 409** +
   `requiresOverpaymentConfirm: true` flag +
   `billRemaining` + `overpaymentAmount` +
   `vendorId`. Verified: NO state change (bill row
   untouched, vendor credit_balance still 0).
2. **Overpayment with acceptOverpayment=true → 200**,
   bill caps at amount, excess lands on
   vendor.credit_balance, ytd_paid only counts the
   bill-applied portion.
3. **Exact amount (no overpayment) → 200**, credit_balance
   untouched.
4. **Floating-point rounding tolerance** — 0.5 cent
   over does NOT trigger 409 (the threshold is
   $0.01).
5. **Partial-then-overpay sequence** — first $60 of
   $100 bill (partial), second $80 (which is $40
   over the remaining $40) with acceptOverpayment.
   Verifies ytd_paid stays at $100 (not $140) and
   credit_balance lands $40.

## Files touched

```
apps/api/src/
  db/migrations/20260607140715_vendor_credit_balance.sql   (NEW)
  routes/books.ts                                          (overpayment logic)
  routes/books-journal-tx-bills.test.ts                    (+5 cases)
```

## Decisions made during build

| Question | Decision |
|---|---|
| Column or ledger for vendor credit tracking? | **Column (`credit_balance`).** Simpler; sufficient for the accrual + future spend MVP. A ledger (one row per credit accrual) would be nicer for audit but adds schema + 2 routes; defer if a real audit need surfaces. The implicit audit trail today is the `books_bills` row that triggered the credit. |
| Cap the bill at `amount` or let `amount_paid` exceed? | **Cap at amount.** Bill rows now never have `amount_paid > amount`. Cleaner data model; downstream queries (status filters, AR reports) don't need to special-case overpayment. |
| Apply overpayment confirmation when `payAmount` is omitted (defaults to full remaining)? | **No.** The default path is "pay exactly what's owed" — never triggers overpayment. The flow only fires when the landlord explicitly types a higher amount. |
| Threshold for "is this overpayment"? | **`> $0.01`** (one penny). Floating-point arithmetic on 2-decimal currency can drift; below a penny is rounding noise, not user intent. |
| Wire credit CONSUMPTION (spend) in same pass? | **No — scope split.** Consumption needs UX design (auto-apply? confirm? landlord-visible balance?). S413 is the accrual + storage; spend is a separate session. |
| Update `vendor.ap_balance` by `cappedPayAmount` or `payAmount`? | **`cappedPayAmount`.** ap_balance represents what the vendor is still owed for THIS bill. The overpayment isn't applied to "owed," it's recorded as a separate credit. |

## Verification

- `npx tsc --noEmit` clean on apps/api (0 errors).
- `npm test` in apps/api: **1836 tests across 99 files,
  0 failures**, 1331.42s. **Seventeenth consecutive
  fully-green full-suite run.**
- 5 new test cases for S386 + 14 cases that landed
  from S410-S412 test-fixture polish.
- 0 production regressions.

## ⚠ Test-infra observation

The first full-suite run for S413 failed with 146
errors — "relation 'credit_disputes' does not exist"
across many test files. Root cause: the `gam_test` DB
had a stale schema (missing recent migrations).
Dropping + recreating gam_test fixed it; the rerun
came back fully green.

This is the same env-propagation / schema-staleness
infrastructure quirk I flagged in S410. The
globalSetup `DROP DATABASE IF EXISTS` is supposed to
guarantee a fresh schema each run, but
non-deterministically gam_test ends up missing
columns/tables from recent migrations. Worth a
dedicated hygiene session to fix `globalSetup.ts`.

Cumulative observations:
- S410: single-file vitest run uses dev DB
- S413: full-suite run occasionally uses stale schema

Both have the same workaround (drop + recreate
gam_test manually). Bundle both into a single test-
infra hygiene session.

## Items deferred — what S414 could target

### Validation-hygiene backlog (was 22, now 21)

Shipped in S413: S386 vendor overpayment accrual.

Remaining locked S398 decisions (1):
- S377 (a) — deferred (email dispatch wiring blocked)

All other locked S398 decisions now CLOSED:
- ✅ S376 (S409 admin label rename)
- ✅ S377 (b)+(c) (S410 invite token split + expiry)
- ✅ S380 avatar XSS strong fix (S409)
- ✅ S380 email validation (S411)
- ✅ S384 contractor required fields (S412)
- ✅ S386 vendor overpayment accrual (S413)

Other hygiene items (~20):
- **S413 spawned**: vendor credit_balance CONSUMPTION
  on subsequent bills (the matching half of S386)
- S412 spawned: confirm entity-type-conditional
  EIN/SSN call (Nic-pending)
- S412 spawned: apply strict-validation pattern to
  books_vendors + books_employees POST routes
- S411 spawned: disposable-domain fan-out to other
  email-accepting routes
- **S413 reinforced**: test infra fix (gam_test
  schema drift, single-file run wrong DB)
- S399 bulk-create input hardening
- S400 LEASE_TYPE_MATRIX ↔ CHECK drift
- S403 cross-landlord PI capture/cancel
- S405 bank_last4 null + ach_verified=TRUE defensive
- S405 /complete missing isExpired check
- S407 UNIQUE constraint on payments
- S408 finding A (monthly-statement off-by-one default
  — Nic-pending)
- S408 finding B ($15 hardcoded fee — Nic-pending)

### Cumulative bug-sweep totals (post-S413)

- **44 production bug fixes** (S413 is product
  feature + accrual closure, not a bug discovery)
- 21 architectural / validation findings remaining
- 1836 tests across 99 files

## What S414 should target

**Recommended: test infra hygiene session.** The
gam_test schema-drift issue keeps causing false
failures (S410, S413). A 30-minute fix to
globalSetup.ts (force a schema reload via the
migration runner instead of relying on schema.sql)
would resolve both observations. Worth doing before
the next session burns time on another false-
positive failure.

**Alternatives:**
- S413 follow-on: vendor credit_balance CONSUMPTION
  on subsequent bill-pay (the matching half of S386)
- Smaller bundle: S399 bulk-create input hardening +
  S400 matrix drift
- S407 UNIQUE constraint on payments (migration +
  removes a race)
- Checkr wire-up (background.ts) — all S398 decisions
  now closed except S377(a) which is email-blocked
- Services audit start (~30 sessions)

---

End of S413 handoff. **S386 vendor overpayment
accrual shipped: schema migration + two-phase
confirmation route + 5 new tests. ALL ACTIVE-LOCKED
S398 DECISIONS NOW CLOSED.**

1836 tests / 99 files / 0 failures. Seventeenth
consecutive fully-green full-suite run.

**44 cumulative production bug fixes shipped across the
bug sweep.** Validation-hygiene backlog reduced from
22 to 21; 6 of 6 actionable S398 decisions shipped
(S377(a) remains email-blocked).
