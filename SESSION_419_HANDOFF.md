# Session 419 — closed

## Theme

**Tenth validation-hygiene micro-session. S403
cross-landlord PI capture/cancel fix shipped on
both `POST /api/terminal/capture/:id` and
`POST /api/terminal/cancel/:id`.**

Suite at S418 close: **1948 / 109 files**.
Suite at S419 close: **1960 / 109 files** (+12 cases,
no new file — added to existing terminal.test.ts).
0 failures. Runtime **61.99s**. Twenty-third
consecutive fully-green full-suite run.

Zero tsc regressions.

## What shipped

### Pre-fix behavior

`POST /api/terminal/capture/:id` and
`POST /api/terminal/cancel/:id` accepted any
PaymentIntent ID from the URL and forwarded it
directly to Stripe with no ownership verification.

The only gate was the `pos.ring_sale` permission,
which any landlord/PM with POS access satisfies.

**Attack shape (from the S403 finding):**
- Landlord A (with `pos.ring_sale`) somehow learns
  Landlord B's PI ID — shared system logs, support
  ticket leak, cross-tenant data spill, etc.
- Landlord A POSTs the foreign PI ID to
  `/capture/:id` or `/cancel/:id`
- Pre-fix: Stripe accepts the call from the platform
  account (the platform owns all Connect-account PIs)
  → Landlord B's transaction is captured or cancelled
  by Landlord A

The threat is bounded because PI IDs are opaque +
ephemeral (the Terminal flow is seconds, end to end)
+ never publicly logged. But the gate was missing in
principle, and the cost to add it is one Stripe
round-trip.

### Fix

Added shared helper `assertPiBelongsToCaller`:

```ts
async function assertPiBelongsToCaller(piId: string, callerLandlordId: string) {
  const intent = await stripe.paymentIntents.retrieve(piId)
  const piLandlordId = (intent.metadata as any)?.landlord_id
  if (!piLandlordId) {
    throw new AppError(404, 'PaymentIntent has no landlord_id metadata; cannot verify ownership')
  }
  if (piLandlordId !== callerLandlordId) {
    throw new AppError(403, 'PaymentIntent does not belong to this landlord')
  }
  return intent
}
```

Both capture and cancel routes now:
1. Resolve the caller's landlord via
   `resolveLandlordIdForUser` (same helper used in
   S403 `/create-payment-intent`)
2. Call `assertPiBelongsToCaller` BEFORE forwarding
   to Stripe
3. 403 on mismatch; 404 on missing metadata
   (defensive — non-GAM PIs that somehow got their
   ID into the URL)

The cost is one extra `stripe.paymentIntents.retrieve`
per capture/cancel. Acceptable for the POS card-
present flow security posture.

## Items shipped

### Route changes

```
apps/api/src/routes/
  terminal.ts                          (1 substantive:
                                         shared helper +
                                         capture + cancel
                                         routes both
                                         verify ownership)
```

### Test changes

```
apps/api/src/routes/
  terminal.test.ts                     (mock fixture
                                         extended with
                                         paymentIntentsRetrieve;
                                         capture + cancel
                                         describes
                                         doubled in size)
```

### Test coverage — 12 net new cases

**Mock fixture extension:**
- Added `paymentIntentsRetrieve` mock to the
  `FakeStripe` factory + `__mocks` export.
- `beforeEach` now clears it alongside the others.

**capture/:id — 4 cases (was 2):**
- Happy: PI metadata.landlord_id matches caller →
  capture called + retrieve called once
- **S419 fix**: cross-landlord PI → 403; capture
  NOT called
- **S419 fix**: PI with no metadata.landlord_id →
  404; capture NOT called
- Non-owner without pos.ring_sale → 403; retrieve
  NOT called (perm gate fires first)

**cancel/:id — 4 cases (was 2):**
- Same shape as capture, applied to cancel.

## Decisions made during build

| Question | Decision |
|---|---|
| Extract the ownership check to a shared helper or inline twice? | **Shared helper.** Two callers + nearly identical logic. Cleaner to maintain; one fix-point if Stripe metadata shape changes. |
| Return 403 or 404 on cross-landlord mismatch? | **403.** "Forbidden" is the standard signal that the caller is authenticated + authorized at the perm layer but not authorized for THIS specific resource. 404 would hide the existence; that's a privacy-vs-debuggability tradeoff and for cross-landlord-in-the-same-platform, 403 is the conventional choice. |
| Return 404 or 422 on missing metadata? | **404.** The PI exists in Stripe but isn't ours to manage — semantically "not found" from the GAM API perspective. 422 would imply a fixable input problem; this is more "this PI isn't a thing GAM manages." |
| Verify ownership in the route or in a middleware? | **In the route.** The check requires a Stripe call that costs ~50-200ms; pushing it to middleware would run it before the perm check (cheaper) fires. Order matters: perm gate first (cheap, 403 fast), then ownership (Stripe round-trip, only if perm passed). |
| Pin the perm-gate-fires-first order in tests? | **Yes — explicit assertions** that retrieve is NOT called when perm fails. Catches a regression that moves the ownership check to middleware. |
| Apply the same fix to the `/connection-token` route? | **No.** That route returns a single-use Terminal session token, not bound to any PI. No ownership concept to verify. |

## Verification

- `npx tsc --noEmit` clean on apps/api (0 errors).
- `npm test` in apps/api: **1960 tests across 109
  files, 0 failures**, 61.99s. **Twenty-third
  consecutive fully-green full-suite run.**
- 12 net new test cases (8 new cases for capture +
  cancel; -2 obsolete cases replaced; +6 from
  added negative paths).
- 0 production regressions.

## Items deferred — what S420 could target

### Validation-hygiene backlog (was 15, now 14)

Shipped in S419: S403 PI capture/cancel ownership.

Remaining:
- S413 spawned: vendor credit_balance CONSUMPTION on
  subsequent bills (the matching half of S386 —
  needs UX design)
- S412 spawned: confirm entity-type-conditional
  EIN/SSN call (Nic-pending)
- S416 spawned: confirm vendor accountNumber/notes
  relaxation (Nic-pending)
- S417 spawned: apply disposable gate to PATCH-email
  routes if/when added
- S400 LEASE_TYPE_MATRIX ↔ CHECK drift (needs
  product input)
- S408 finding A (monthly-statement off-by-one
  default — Nic-pending)
- S408 finding B ($15 hardcoded fee — Nic-pending)
- S377 (a) email-blocked
- Plus a handful of smaller items

### Cumulative bug-sweep totals (post-S419)

- **46 production bug fixes** (+1 in S419 — cross-
  landlord PI capture/cancel)
- 14 architectural / validation findings remaining
- 1960 tests across 109 files
- Suite baseline: **60-62s on a clean machine**

## What S420 should target

**Recommended: Checkr wire-up (background.ts).**
All actionable hygiene-backlog items have either
shipped or are blocked on Nic input. The remaining
items are mostly product-decision-pending. Checkr
is the next natural arc — credentials in hand per
memory, route file at background.ts has 25 routes
with no current coverage, and the integration is
the last major pre-launch external dependency.

**Alternatives:**
- S413 vendor credit_balance CONSUMPTION (needs
  UX design first)
- Services audit start (~30 sessions of slice
  coverage)
- Wait for Nic decisions on the 4 Nic-pending items
  and ship those in a batch

---

End of S419 handoff. **Both terminal.ts
capture/cancel routes now verify PI ownership via
Stripe metadata before forwarding. 12 new test
cases pinning the ownership gate + the perm-first
ordering.**

1960 tests / 109 files / 0 failures. Twenty-third
consecutive fully-green full-suite run.

**46 cumulative production bug fixes shipped across the
bug sweep.** Validation-hygiene backlog reduced from
15 to 14.
