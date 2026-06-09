# Session 405 — closed

## Theme

**posCustomerOnboarding.ts gap-close slice — closes the
file at 3/3 (100%). 23 new test cases, 0 production
bug fixes, 1 architectural finding (bank_last4 null +
ach_verified=TRUE edge case).**

Suite at S404 close: **1677 / 91 files**.
Suite at S405 close: **1700 / 92 files** (+23 cases,
+1 file). 0 failures. Runtime 1531.79s. Ninth
consecutive fully-green full-suite run.

Zero tsc regressions.

Fourth zero-bug slice of the sweep (after S398, S402,
S404). Crossed the 1700-test milestone.

## Items shipped

### Test coverage — 23 cases / 3 describe blocks

New file: `apps/api/src/routes/posCustomerOnboarding.test.ts`
(~370 lines)

**GET /:token — 6 cases**
- Happy: preview shape with merchant + customer names
- Unknown token → 404
- Cancelled → 409
- Already accepted → 409
- Expired → 410
- Merchant name falls back to first+last when
  landlord.business_name is null (COALESCE branch pin)

**POST /:token/start — 9 cases**
- Happy: creates Stripe customer + SetupIntent,
  flips invitation status in_progress
- Reuses existing Stripe customer when one is stamped
  (no second customers.create call)
- Reuses existing SetupIntent (still pending)
- Creates new SetupIntent when prior one was canceled
  (stale recovery)
- SetupIntent created with the correct Financial
  Connections + us_bank_account params + GAM metadata
- Unknown token → 404
- Cancelled → 409
- Accepted → 409
- Expired → 410

**POST /:token/complete — 8 cases**
- Happy: ach_verified=TRUE + bank_last4 + accepted flip
- Sets verified PM as customer's default_payment_method
- default_payment_method failure logged but does NOT
  fail onboarding (best-effort contract)
- Idempotent: already-accepted returns success without
  re-running Stripe
- No setup_intent_id yet → 400 "call /start first"
- SetupIntent status not succeeded → 409;
  pos_customers row stays unverified
- bank_last4 null when payment_method.us_bank_account
  missing (architectural finding pinned)
- Unknown token → 404

## Architectural findings (worth recording, no fix in slice)

### Finding 1: `bank_last4` null but `ach_verified=TRUE`

When `POST /:token/complete` runs against a
SetupIntent whose `payment_method` doesn't include a
`us_bank_account` block (effectively impossible given
the route creates the SI restricted to that type, but
theoretically possible from a future Stripe API
change), `ach_verified` is flipped to TRUE while
`bank_last4` is written as NULL.

The verification gate downstream consumers care about
is `ach_verified`; the `bank_last4` is used for UI
disambiguation. A row with verified=TRUE + last4=NULL
would render as "Verified (••••)" — confusing but not
incorrect. Pinned in the slice; flagged for
validation-hygiene as a defensive-check class item
(refuse the complete and require frontend to re-run
/start with a clean PM).

### Finding 2: `/complete` does not check `isExpired`

`GET /:token` and `POST /:token/start` both check
expiration; `POST /:token/complete` does not. A user
who starts a flow before expiration and completes it
after (held the browser tab open) gets through.
Likely intentional (don't kill an in-flight flow
mid-Stripe-OAuth) but worth surfacing as a deliberate-
or-bug question for Nic. Flagged for the validation-
hygiene micro-session.

## Files touched

```
apps/api/src/routes/
  posCustomerOnboarding.test.ts        (NEW — ~370 lines,
                                          23 cases)
```

No production code touched. No migrations. No schema
changes. No frontend touched.

## Decisions made during build

| Question | Decision |
|---|---|
| Mock Stripe at the module level or via dep-injection? | **Module-level vi.mock — same pattern as terminal.test.ts.** Avoids inventing a new pattern; `getStripe()` constructs a new Stripe each call, so the mock applies cleanly. |
| Pin the COALESCE fallback for merchant_name? | **Yes.** business_name null is the typical case (most landlords haven't set one); the COALESCE branch is the actual default path in production. |
| Pin the customer-stripe-id reuse path? | **Yes.** Idempotency on re-running /start is a documented contract in the file header; pin the no-second-call assertion. |
| Pin the "default_payment_method failure is logged but doesn't fail onboarding" branch? | **Yes — this is the best-effort contract** documented in the route's catch block. A future refactor that propagates the error would silently break the onboarding flow. |
| Fix the bank_last4-null-but-ach_verified=TRUE branch in S405? | **No — flag and defer.** The defensive check requires deciding what the right UX is (refuse + restart? warn?). Belongs in validation-hygiene with the other 24 items. |
| Fix the missing isExpired check on /complete in S405? | **No — flag and defer.** Could be deliberate (don't kill in-flight flow). Needs Nic input before changing behavior. |

## Verification

- `npx tsc --noEmit` clean on apps/api (0 errors).
- `npm test` in apps/api: **1700 tests across 92 files,
  0 failures**, 1531.79s. **Ninth consecutive fully-
  green full-suite run.** Crossed 1700-test milestone.
- 23 new test cases.
- 0 production bug fixes (clean slice).
- 2 architectural findings (bank_last4 edge, expiry
  check on /complete).
- 0 production regressions.

## Items deferred — what S406 could target

### Medium-band batch remaining

After posCustomerOnboarding.ts close (3 routes):
- **stripe.ts — 5 routes (279 lines)**
- **payments.ts — 4 routes (429 lines)**
- **reports.ts — 5 routes (489 lines)** — largest;
  most likely to surface bugs given financial-data
  scope.

Total remaining medium-band: **14 routes across 3 files.**

**Recommend S406 = stripe.ts gap-close.** Smallest
remaining file by lines (279). Then payments.ts then
reports.ts to close the route-test sweep arc today.

### Validation-hygiene backlog (now 26 items)

S404 carryover (24) + S405's two findings (bank_last4
null + missing expiry check on /complete).

### Pending Nic decisions

Unchanged + 1 new ambiguity (S405 finding #2 — is the
missing isExpired check on /complete deliberate?).
Bundle with the S398 product decisions when next
hygiene session lands.

### Per directive: fix all bugs before Checkr

Cumulative bug-sweep totals (post-S405):
- **40 production bug fixes** (unchanged — clean slice)
- 26 architectural / validation findings flagged
- 1700 tests covering ~386 of 506 audited routes (76%)

## Items deferred (cross-session docket, post-S405)

Unchanged from S404 + the two S405 hygiene findings.

## Nic-pending

S405 finding #2 (/complete expiry check) added to the
list for next hygiene session.

## What S406 should target

**Recommended: stripe.ts gap-close** (5 routes, 279
lines). Smallest remaining file. Then payments.ts (4
routes, 429 lines), then reports.ts (5 routes, 489
lines) to close the route-test sweep arc today.

**Alternatives:**
- payments.ts (4 routes, 429 lines)
- reports.ts (5 routes, 489 lines — most bug potential)
- Validation-hygiene micro-session (26-item backlog +
  S398 product decisions)
- background.ts + Checkr (defer until route-test
  sweep closes)

---

End of S405 handoff. **posCustomerOnboarding.ts arc
CLOSED at 3/3 routes (100%).** Slice / 23 tests / 0
production bug fixes (clean — public token-gated flow
correctly state-machined). Fourth zero-bug slice of
the sweep.

1700 tests / 92 files / 0 failures. Ninth consecutive
fully-green full-suite run. Crossed 1700-test
milestone.

**40 cumulative production bug fixes shipped across the
bug sweep.**
