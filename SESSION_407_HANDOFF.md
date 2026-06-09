# Session 407 — closed

## Theme

**payments.ts gap-close slice — closes the file at 4/4
(100%). 30 new test cases, 1 production bug fix
(double-bill-prone /initiate-rent-collection).**

Suite at S406 close: **1724 / 93 files**.
Suite at S407 close: **1754 / 94 files** (+30 cases,
+1 file). 0 failures. Runtime 1515.05s. Eleventh
consecutive fully-green full-suite run.

Zero tsc regressions.

## Production bug fixes shipped

### `POST /api/payments/initiate-rent-collection` — duplicate rent charges on second invocation

**Severity: HIGH — admin double-click or scheduler
misfire double-bills EVERY tenant for the target
month. No DB-level guard caught it.**

Pre-fix flow:
- Route loops over eligible units
- For each unit: `INSERT INTO payments
  (unit_id, tenant_id, landlord_id, type='rent',
  amount, due_date) VALUES (...)` unconditionally
- No SELECT-then-skip; no UNIQUE constraint on
  `payments(unit_id, type, due_date)`; no ON CONFLICT

Reproduction:
1. Admin / scheduler calls `POST /initiate-rent-collection`
   with `{targetMonth: '2026-07'}` — N rent rows created
2. Admin double-clicks the button (or scheduler retries
   after a network blip, or runs twice due to deploy
   restart) — **N more** rent rows created with the
   same `(unit_id, due_date)`
3. Webhook flow processes both, tenant ACH is pulled
   twice for the same month's rent

**Fix:** added a `SELECT ... LIMIT 1` guard inside the
loop that checks for any non-cancelled rent payment
for the same `(unit_id, due_date)`. Skip silently
when found; response now includes `skipped` count
alongside `initiated` + `errors`.

This is a SELECT-then-INSERT pattern (not bulletproof
against a true concurrent admin double-click race
within the same millisecond), but with admin-gated
+ cron-scheduled access patterns the realistic threat
is sequential repeat invocations — which the guard
covers.

Architectural follow-on: a UNIQUE constraint on
`payments(unit_id, type, due_date) WHERE status != 'cancelled'`
would close the race window completely. Flagged for
the validation-hygiene micro-session as a migration
class item — needs to handle existing duplicates if
any are in the dev DB.

## Items shipped

### Test coverage — 30 cases / 4 describe blocks

New file: `apps/api/src/routes/payments.test.ts`
(~570 lines)

**GET /api/payments — 8 cases**
- Landlord sees only own payments (cross-tenant filtered)
- Tenant sees only own payments
- Admin sees all
- Team-role without landlordId → empty (no leak)
- Team-role with landlordId but no payments.view_all → empty
- Team-role with landlordId + perm → sees landlord's payments
- status + type filters narrow results
- Pagination: page=1 limit=1 returns 1 row + correct
  total + totalPages

**POST /initiate-rent-collection — 7 cases**
- Non-admin → 403
- Bad targetMonth format → 400
- Happy: creates pending rent payments for eligible units
- **S407 fix:** second call same month skips instead
  of duplicating; verified DB row count stays at 1
- Different targetMonth creates a separate row
  (idempotency is per-month, not per-unit)
- Unit with payment_block=TRUE excluded (eviction-mode)
- Tenant without ach_verified excluded

**POST /:id/handle-return — 5 cases**
- Non-admin → 403
- Unknown returnCode → 400
- Unknown payment id → 404
- Non-zero-tolerance R01: status→returned, monitoring
  log row, no ACH suspension
- Zero-tolerance R10: status→returned + tenant
  ach_verified→FALSE + 'zero_tolerance_block' log row

**POST /:id/pay — 10 cases**
- Non-tenant → 403
- Cross-tenant payment id → 403 "Not your payment"
- Unknown payment id → 404
- Payment already settled → 409
- Payment already processing (with PI id) → 409
- Tenant without stripe_customer_id → 409
- Happy Connect-ready → destination charge,
  status→processing, platform_held=FALSE
- S113-PhaseA fallback: landlord NOT Connect-ready
  → platform charge + platform_held=TRUE
- Card payment: status→settled immediately
- Invalid paymentMethodType enum → 400

## Files touched

```
apps/api/src/routes/
  payments.ts                          (1 surgical fix:
                                         idempotency
                                         guard in
                                         initiate-rent-collection)
  payments.test.ts                     (NEW — ~570 lines,
                                         30 cases)
```

No migrations. No schema changes. No frontend touched.

## Decisions made during build

| Question | Decision |
|---|---|
| Fix idempotency in the same pass? | **Yes — fix-it-right.** HIGH-severity (double-bills every tenant for the month). Six-line SELECT-then-skip pattern; no schema migration needed. UNIQUE constraint would be cleaner but requires a separate migration session with backfill handling. |
| Flag the residual race (admin double-click within same ms)? | **Yes — note in handoff.** SELECT-then-INSERT is not atomic; two concurrent calls in the same instant could both pass the SELECT and double-insert. Realistic admin/cron threat is sequential not concurrent; flagged the UNIQUE-constraint follow-on as the bulletproof fix. |
| Mock all three services (supersedence, adminNotifications, stripeConnect)? | **Yes — vi.mock module-level.** Pay-route exercises ~150 lines of logic across multiple services + Stripe. Mocking keeps the slice focused on route-layer contract (gate, validate, route to correct charge type, persist). |
| Pin the S113-PhaseA platform-held fallback explicitly? | **Yes.** This is the load-bearing safety net for the Connect rollout — if a future refactor breaks the fallback branch, tenants would hit a 500 wall during onboarding incomplete states. |
| Pin BOTH ACH return code paths (zero-tolerance + standard)? | **Yes.** The zero-tolerance branch has side effects (tenant ACH suspension + extra log row); the standard branch doesn't. Catching a regression that conflates them needs both pinned. |

## Verification

- `npx tsc --noEmit` clean on apps/api (0 errors).
- `npm test` in apps/api: **1754 tests across 94 files,
  0 failures**, 1515.05s. **Eleventh consecutive fully-
  green full-suite run.**
- 30 new test cases.
- 1 production bug fix (initiate-rent-collection
  idempotency).
- 0 production regressions.

## Items deferred — what S408 could target

### Last medium-band file

After payments.ts close:
- **reports.ts — 5 routes (489 lines)** — LAST
  remaining medium-band file. Financial-data scope;
  largest likely-bug surface of the remaining work.

**Recommend S408 = reports.ts gap-close — CLOSES THE
ROUTE-TEST SWEEP ARC.** This was the last file in
the medium-band batch. After S408 ships, the
route-test sweep arc is complete and the next focus
becomes: validation-hygiene micro-session, services
audit, jobs audit, or background.ts+Checkr wire-up.

### Validation-hygiene backlog (now 27 items)

S406 carryover (26) + S407's UNIQUE-on-payments
constraint follow-on (eliminate the residual race).

### Pending Nic decisions

Unchanged.

### Per directive: fix all bugs before Checkr

Cumulative bug-sweep totals (post-S407):
- **43 production bug fixes** (+1 in S407)
- 27 architectural / validation findings flagged
- 1754 tests covering ~395 of 506 audited routes (78%)

## Items deferred (cross-session docket, post-S407)

Unchanged from S406 + the UNIQUE-on-payments constraint
follow-on above.

## Nic-pending

Unchanged.

## What S408 should target

**Recommended: reports.ts gap-close** (5 routes, 489
lines). **CLOSES THE ROUTE-TEST SWEEP ARC.** Last
medium-band file; largest bug surface of the remaining
route-layer work.

**Alternatives:**
- Validation-hygiene micro-session (27-item backlog +
  S398 product decisions)
- background.ts + Checkr (Now actively unblocked —
  route-test sweep one file away from closure)

---

End of S407 handoff. **payments.ts arc CLOSED at 4/4
routes (100%).** Slice / 30 tests / 1 HIGH-severity
production bug fix (double-bill on
initiate-rent-collection).

1754 tests / 94 files / 0 failures. Eleventh
consecutive fully-green full-suite run.

**43 cumulative production bug fixes shipped across the
bug sweep.** ONE FILE LEFT in the route-test sweep
arc: reports.ts.
