# Session 403 — closed

## Theme

**terminal.ts gap-close slice — closes the file at 4/4
(100%). 15 new test cases, 2 production bug fixes, 1
architectural finding (cross-landlord PI capture/cancel
deferred to a follow-on slice).**

Suite at S402 close: **1639 / 89 files**.
Suite at S403 close: **1654 / 90 files** (+15 cases,
+1 file). 0 failures. Runtime 1538.97s. Seventh
consecutive fully-green full-suite run.

Zero tsc regressions.

## Production bug fixes shipped

### 1. `POST /api/terminal/create-payment-intent` — client could override `metadata.landlord_id`

**Severity: medium — authenticated landlord/PM could
poison Stripe-side audit attribution.**

Pre-fix at terminal.ts:44:
```ts
metadata: { landlord_id: req.user!.profileId, ...metadata }
```

JS spread order matters: any client-supplied
`metadata.landlord_id` overrode the server-set value
because `...metadata` came AFTER the server field.
A client posting `metadata: { landlord_id:
'<some-other-landlord-uuid>' }` would have their
Stripe PaymentIntent attributed to the foreign
landlord — useful for muddying audit trails after a
disputed transaction.

**Fix:** swap spread order so the server-set field
wins:
```ts
metadata: { ...metadata, landlord_id: landlordId }
```

Non-conflicting client metadata still flows through
(e.g. `metadata: { register: 'POS-1' }`).

### 2. `POST /api/terminal/create-payment-intent` — team-role landlord_id misresolution

**Severity: medium — same class as S400's units.ts
bug. Team roles (PM/onsite_manager/maintenance) with
`pos.ring_sale` wrote their user_id into Stripe
metadata as "landlord_id" — garbled audit trail.**

Pre-fix used `req.user!.profileId` which is the
landlord_id for `role=landlord` but the user_id for
team roles. The Stripe-side metadata.landlord_id was
therefore a random user UUID, not a landlord UUID,
whenever a PM rang a sale.

**Fix:** use the shared `resolveLandlordIdForUser`
helper (now imported here too); also throws 400 if
the caller has no landlord scope at all (e.g. a tenant
somehow holding the perm).

## Architectural finding (worth recording)

**Cross-landlord PaymentIntent capture / cancel.**
The routes `POST /api/terminal/capture/:id` and
`POST /api/terminal/cancel/:id` accept any Stripe
PaymentIntent ID and forward it to Stripe without
verifying that the PI's `metadata.landlord_id` matches
the caller's resolved landlord. A landlord with
`pos.ring_sale` who somehow learns another landlord's
PI ID could capture or cancel it.

Realistic blast radius is small — PI IDs are opaque,
ephemeral (Terminal flow is steps 1→5 in seconds),
and not exposed publicly. But the gate is missing in
principle. Fix: read the PI from Stripe first,
compare `metadata.landlord_id`, then capture/cancel.

Deferred to the validation-hygiene micro-session
(now 24 items) since the fix requires a Stripe round-
trip on every capture/cancel which is mild latency
overhead worth balancing against the threat model.

## Items shipped

### Test coverage — 15 cases / 4 describe blocks

New file: `apps/api/src/routes/terminal.test.ts`
(~245 lines)

**POST /api/terminal/connection-token — 3 cases**
- Happy: returns secret from stripe.terminal mock
- Non-owner without pos.ring_sale → 403
- Unauthenticated → 401

**POST /api/terminal/create-payment-intent — 8 cases**
- Happy: amount→cents, server-set metadata
- **S403 fix:** client cannot override metadata.landlord_id
- **S403 fix:** PM team-role gets actual landlord_id
- amount=0 → 400
- negative amount → 400
- missing amount → 400
- Tenant with perm but no landlord scope → 400
  "No landlord scope on this user"
- Default description applied when none provided

**POST /api/terminal/capture/:id — 2 cases**
- Happy: passes PI id to stripe.paymentIntents.capture,
  returns {id, status, amount} for record-back
- Non-owner without pos.ring_sale → 403

**POST /api/terminal/cancel/:id — 2 cases**
- Happy: passes PI id to stripe.paymentIntents.cancel
- Non-owner without pos.ring_sale → 403

## Files touched

```
apps/api/src/routes/
  terminal.ts                          (2 surgical fixes:
                                         resolveLandlordIdForUser
                                         + metadata spread order)
  terminal.test.ts                     (NEW — ~245 lines,
                                         15 cases)
```

No migrations. No schema changes. No frontend touched.

## Decisions made during build

| Question | Decision |
|---|---|
| Fix the cross-landlord capture/cancel in S403? | **No — flag and defer.** Adds a Stripe round-trip on every capture/cancel. Threat model is narrow (need to know an opaque ephemeral PI ID). Better-suited to the validation-hygiene micro-session where the latency trade can be reasoned about against the full backlog. |
| Use vi.mock with `default: FakeStripe` pattern? | **Yes — same shape as webhooks.test.ts and the other 4 Stripe-mocking files in the codebase.** Avoids inventing a new mocking convention. |
| Pin the default description ('GAM POS Sale')? | **Yes.** Small, but the description appears on Stripe-side reporting / merchant statements — silent regressions matter. |
| Test the OWNER_ROLES auto-pass branch explicitly? | **No — covered implicitly by the happy paths** which use landlord tokens with no perm but pass. The S402 explicit PM-no-perm pattern covers the negative branch already. |
| Pin amount=0 separately from negative? | **Yes — `!amount` catches both 0 and undefined**, but negative goes through a different branch (`amount <= 0`). Three test cases isolate each input class so a future refactor can't silently collapse them. |

## Verification

- `npx tsc --noEmit` clean on apps/api (0 errors).
- `npm test` in apps/api: **1654 tests across 90 files,
  0 failures**, 1538.97s. **Seventh consecutive fully-
  green full-suite run.**
- 15 new test cases.
- 2 production bug fixes (metadata override + team-role
  landlord_id misresolution).
- 1 architectural finding (cross-landlord PI
  capture/cancel).
- 0 production regressions.

## Items deferred — what S404 could target

### Medium-band batch remaining

After terminal.ts close (4 routes):
- **bankAccounts.ts — 4 routes (129 lines)** — next-
  smallest by lines.
- **posCustomerOnboarding.ts — 3 routes (253 lines)**
- **stripe.ts — 5 routes (279 lines)**
- **payments.ts — 4 routes (429 lines)**
- **reports.ts — 5 routes (489 lines)** — largest;
  most likely to surface bugs given financial-data
  scope.

Total remaining medium-band: **21 routes across 5 files.**

**Recommend S404 = bankAccounts.ts gap-close.** Same
size category as terminal/notifications, peer to the
already-shipped slices.

### Validation-hygiene backlog (now 24 items)

S402 carryover (23) + S403's cross-landlord PI
capture/cancel finding.

### Pending Nic decisions

Unchanged.

### Per directive: fix all bugs before Checkr

Cumulative bug-sweep totals (post-S403):
- **40 production bug fixes** (+2 in S403)
- 24 architectural / validation findings flagged
- 1654 tests covering ~379 of 506 audited routes (75%)

## Items deferred (cross-session docket, post-S403)

Unchanged from S402 + the S403 cross-landlord PI
finding above.

## Nic-pending

Unchanged.

## What S404 should target

**Recommended: bankAccounts.ts gap-close** (4 routes,
129 lines). Same size class as terminal/notifications.

**Alternatives:**
- posCustomerOnboarding.ts (3 routes, 253 lines)
- stripe.ts (5 routes, 279 lines)
- reports.ts (5 routes, 489 lines — most bug potential)
- Validation-hygiene micro-session (24-item backlog +
  S398 product decisions)
- background.ts + Checkr (defer until route-test
  sweep closes)

---

End of S403 handoff. **terminal.ts arc CLOSED at 4/4
routes (100%).** Slice / 15 tests / 2 production bug
fixes / 1 architectural finding deferred.

1654 tests / 90 files / 0 failures. Seventh
consecutive fully-green full-suite run.

**40 cumulative production bug fixes shipped across the
bug sweep.** Crossed the 40 milestone.
