# Session 418 — closed

## Theme

**Ninth validation-hygiene micro-session. S405
defensive bundle on `POST /api/pos-customer-
onboarding/:token/complete` — two related
defensive checks shipped together.**

Suite at S417 close: **1947 / 109 files**.
Suite at S418 close: **1948 / 109 files** (+1 net new
case; +2 cases for the new gates, −1 because the old
"bank_last4 falls back to null" test was inverted
into the new "bank identifier missing → 422" test).
0 failures. Runtime **60.95s**. Twenty-second
consecutive fully-green full-suite run.

Zero tsc regressions.

## What shipped

### Fix 1: `/complete` enforces expiry mid-flow

**Pre-fix:** the route checked `isExpired` on
`GET /:token` and `POST /:token/start` but NOT on
`POST /:token/complete`. A customer who started bank
verification before expiry could complete it after
expiry — Stripe doesn't know about our `expires_at`
column, so the SetupIntent stays valid indefinitely.

**Post-fix:** `if (isExpired(inv)) throw new
AppError(410, 'Invitation expired')` added as the
fourth gate, matching the pattern on the sibling
routes.

The order is intentional — expiry check fires
BEFORE the Stripe `setupIntents.retrieve` call. An
expired invitation no longer costs a Stripe API
round-trip.

### Fix 2: `/complete` refuses ach_verified=TRUE when bank_last4 is null

**Pre-fix:** if `payment_method.us_bank_account` was
missing on the SetupIntent (which the SetupIntent's
`payment_method_types: ['us_bank_account']`
constraint makes nearly impossible — but possible on
Stripe API contract drift or malformed `expand`),
the route flipped `ach_verified=TRUE` with
`bank_last4=NULL`. Downstream NACHA monitoring + UI
disambiguation expect the pair to be present
together.

**Post-fix:** if `bankLast4` is null on a `succeeded`
SetupIntent, throw 422 with a re-run-/start
suggestion. The pos_customers row is not stamped;
the invitation status stays `in_progress`. Frontend
can recover by re-running `/start` (which is
idempotent on still-pending SetupIntents).

422 was chosen over 409 (the conflict status used
for "not-succeeded SetupIntent") because the
SetupIntent IS succeeded; the issue is data
extraction from Stripe's response, not a state-
machine conflict.

## Items shipped

### Route changes

```
apps/api/src/routes/
  posCustomerOnboarding.ts             (2 gates added:
                                         isExpired
                                         check + bank
                                         identifier
                                         refusal)
```

### Test changes

```
apps/api/src/routes/
  posCustomerOnboarding.test.ts        (1 test inverted +
                                         1 new test)
```

- **Inverted**: the prior "bank_last4 falls back to
  null when payment_method.us_bank_account is
  missing" test (which pinned the buggy 200
  behavior with verified=TRUE + last4=NULL) now
  asserts 422 + DB row unchanged + invitation status
  still `in_progress`.
- **New**: "expired invitation → 410 even if /start
  succeeded earlier" — pins the new gate order
  (expiry check fires BEFORE the Stripe API call).

## Decisions made during build

| Question | Decision |
|---|---|
| 422 or 409 for the bank-identifier-missing case? | **422 Unprocessable Entity.** The SetupIntent IS succeeded; the conflict is in Stripe's response data, not the state machine. 409 is reserved for "wrong SetupIntent status." |
| Refuse the complete vs auto-retry `setupIntents.retrieve` once more? | **Refuse + ask frontend to re-run /start.** A retry inside the route is the wrong shape — if Stripe's first response was malformed, retrying with the same SetupIntent ID would likely return the same response. Re-run /start creates a fresh SetupIntent and a clean session. |
| Apply the isExpired check BEFORE or AFTER the Stripe API call? | **Before.** An expired invitation should fail fast without burning a Stripe round-trip. Also makes the test slice cleaner (can assert `setupIntentsRetrieve` was NOT called). |
| Invert the existing "buggy 200 behavior" test or write a new one? | **Invert.** The existing test was explicitly pinning the finding so a future fix would surface as a test diff — exactly the situation here. Inverting is the documented-intent path. |
| Add a /retry endpoint as a smarter recovery? | **No — out of scope.** Frontend re-running /start is the documented recovery; adding /retry would duplicate logic. If a smarter retry shape is needed, that's product UX work. |
| Block the route entirely when bank_last4 is null, or downgrade to a warning? | **Block (422).** A "verified" tag with no bank identifier downstream causes data quality issues that are hard to diagnose. Refusing now is cheaper than fixing the data later. |

## Verification

- `npx tsc --noEmit` clean on apps/api (0 errors).
- `npm test` in apps/api: **1948 tests across 109
  files, 0 failures**, 60.95s. **Twenty-second
  consecutive fully-green full-suite run.**
- 1 test inverted (now pins the fixed behavior) + 1
  new test for the expiry gate.
- 0 production regressions.

## Items deferred — what S419 could target

### Validation-hygiene backlog (was 17, now 15)

Shipped in S418:
- S405 finding 1 (`/complete` missing isExpired)
- S405 finding 2 (`bank_last4` null + `ach_verified=TRUE`
  defensive)

Remaining:
- S413 spawned: vendor credit_balance CONSUMPTION on
  subsequent bills (the matching half of S386)
- S412 spawned: confirm entity-type-conditional
  EIN/SSN call (Nic-pending)
- S416 spawned: confirm vendor accountNumber/notes
  relaxation (Nic-pending)
- S417 spawned: apply disposable gate to PATCH-email
  routes if/when added
- S400 LEASE_TYPE_MATRIX ↔ CHECK drift (needs
  product input on canonical unit types)
- S403 cross-landlord PI capture/cancel (Stripe
  round-trip required)
- S408 finding A (monthly-statement off-by-one
  default — Nic-pending)
- S408 finding B ($15 hardcoded fee — Nic-pending)
- S377 (a) email-blocked

### Cumulative bug-sweep totals (post-S418)

- **45 production bug fixes** (+1 in S418 — the
  bank_last4-null-but-verified-TRUE case was a real
  data-quality bug that would only surface in
  rare Stripe API contract drift, but the fix
  closes the door cleanly)
- 15 architectural / validation findings remaining
- 1948 tests across 109 files
- Suite baseline: **60-62s on a clean machine**

## What S419 should target

**Recommended: S403 cross-landlord PI capture/cancel.**
The terminal.ts capture/cancel routes don't verify
that the Stripe PaymentIntent ID belongs to the
caller's Connect account. A landlord with
`pos.ring_sale` who learns another landlord's PI ID
could capture or cancel it. Fix is a small Stripe
round-trip (read PI, compare `metadata.landlord_id`),
no schema work needed.

**Alternatives:**
- S413 follow-on: vendor credit_balance CONSUMPTION
  (needs UX design)
- S400 LEASE_TYPE_MATRIX ↔ CHECK drift (needs
  product input)
- Checkr wire-up (background.ts) — all locked S398
  decisions now closed except S377(a)
- Services audit start

---

End of S418 handoff. **Two related defensive checks
shipped on /complete: isExpired enforcement + bank-
identifier-missing refusal. 1 test inverted + 1 new
test pinning the gate order.**

1948 tests / 109 files / 0 failures. Twenty-second
consecutive fully-green full-suite run.

**45 cumulative production bug fixes shipped across the
bug sweep.** Validation-hygiene backlog reduced from
17 to 15.
