# Session 406 — closed

## Theme

**stripe.ts gap-close slice — closes the file at 5/5
(100%). 24 new test cases, 2 production bug fixes on
`POST /tenant/confirm-setup`.**

Suite at S405 close: **1700 / 92 files**.
Suite at S406 close: **1724 / 93 files** (+24 cases,
+1 file). 0 failures. Runtime 1435.48s. Tenth
consecutive fully-green full-suite run.

Zero tsc regressions.

## Production bug fixes shipped

### 1. `POST /api/stripe/tenant/confirm-setup` missing tenant-only check

**Severity: medium — non-tenant callers (landlord, PM,
admin) hit a 500 from the ach_monitoring_log
tenant_id FK violation instead of a clean 403.**

Sibling routes `/tenant/setup` and `/tenant/payment-methods`
enforce `if (req.user!.role !== 'tenant') 403` at the
top. This route did not. A landlord calling
`POST /tenant/confirm-setup` with any
setupIntentId/paymentMethodId pair would:
1. Pass zod body validation
2. Hit `stripe.paymentMethods.retrieve` (Stripe mock
   returns OK)
3. Silently no-op the `UPDATE tenants WHERE id =
   req.user.profileId` (caller's profileId is the
   landlord_id, never matches a tenant row)
4. 500 on the `INSERT INTO ach_monitoring_log
   (tenant_id, ...) VALUES (req.user.profileId, ...)`
   — FK enforces tenant_id → tenants(id)

**Fix:** added the tenant-only check at the top of
the handler, consistent with the sibling routes.

### 2. `POST /api/stripe/tenant/confirm-setup` did not verify paymentMethodId ownership

**Severity: medium — silent data corruption: a tenant
could supply another tenant's payment-method ID and
stamp their OWN tenants row with the foreign
bank_last4 + routing_number.**

Pre-fix flow:
- Tenant A passes `paymentMethodId = pm_belonging_to_B`
- Route retrieves the PM from Stripe (works — Stripe
  doesn't enforce ownership at retrieve time)
- Route reads `pm.us_bank_account.last4` and stamps
  it onto tenant A's row
- tenant A is now "verified" with tenant B's bank
  identifiers

Real impact: if tenant A had a typo'd or guessed PM
id from another tenant in the system, their
verification record is wrong + their first-sender log
points to the wrong bank fingerprint. NACHA monitoring
downstream would attribute the wrong bank to tenant A.

**Fix:** before stamping, fetch the caller's
`stripe_customer_id` and verify
`pm.customer === tenant.stripe_customer_id`. 403 on
mismatch, 409 if the caller hasn't initialized a
Stripe customer yet (call /tenant/setup first).

## Items shipped

### Test coverage — 24 cases / 5 describe blocks

New file: `apps/api/src/routes/stripe.test.ts`
(~440 lines)

**POST /connect/onboarding-session — 6 cases**
- Happy: entity=user creates/reuses caller's account
- entity=pm_company + active owner → 200 with
  business_email + name forwarded
- entity=pm_company + non-owner staff → 403
- entity=pm_company + non-staff caller → 403
- entity=pm_company + missing entityId → 400
- Invalid entity enum → 400

**GET /connect/status — 4 cases**
- entity=user + no stamped account → exists:false
- entity=user + stamped → returns Stripe status
- entity=pm_company + non-staff → 403
- entity=pm_company + missing entityId → 400

**POST /tenant/setup — 5 cases**
- Non-tenant role → 403
- ach first-setup: calls createTenantAchSetup +
  stamps stripe_customer_id
- card first-setup: creates customer + SetupIntent
  with card type + usage:off_session
- Reuses existing stripe_customer_id (no second
  createTenantAchSetup call)
- Invalid method enum → 400

**POST /tenant/confirm-setup — 5 cases**
- Happy: ach_verified + bank info stamped, first-sender
  log row created
- **S406 fix:** non-tenant → 403 (was 500 pre-fix)
- **S406 fix:** PM from another tenant's customer → 403
  + caller's row NOT updated
- Tenant with no stripe_customer_id yet → 409
- Missing setupIntentId → 400

**GET /tenant/payment-methods — 4 cases**
- Non-tenant → 403
- Tenant with no stripe_customer_id → [] (no Stripe
  calls)
- Happy: combines ACH + card lists with normalized
  shape (id/type/bankName/last4/brand/exp/country)
- Tenant not found → 404

## Files touched

```
apps/api/src/routes/
  stripe.ts                            (2 surgical fixes:
                                         tenant-only check
                                         + PM ownership
                                         verify on
                                         confirm-setup)
  stripe.test.ts                       (NEW — ~440 lines,
                                         24 cases)
```

No migrations. No schema changes. No frontend touched.

## Decisions made during build

| Question | Decision |
|---|---|
| Fix the missing tenant-only check in the same pass? | **Yes — fix-it-right.** Same class as the sibling routes' existing pattern; 4-line addition; no scope expansion. Pre-fix was a hard 500 on cross-role calls, not just bad-UX. |
| Fix the PM ownership verification in the same pass? | **Yes.** Silent data corruption is the worst kind — never surfaced, never debuggable, NACHA log gets stale fingerprints. Defensive check is cheap (one extra DB query + comparison). |
| Mock stripeConnect at the module level via vi.mock? | **Yes.** Same shape as services/notifications mock in S402. Avoids the Stripe Connect Express live path (which would need real Stripe API key + Connect mock harness). |
| Use `vi.mock('../lib/stripe', ...)` so getStripe() returns a fake? | **Yes.** Cleaner than mocking the `stripe` module globally — the route imports `getStripe` not the SDK directly, so mocking the lib layer scopes the mock to this route's needs only. |
| Pin the COALESCE business_email→user.email fallback in onboarding-session? | **Implicitly covered.** The PM-company happy test verifies business_email is forwarded; the user-email fallback path isn't exercised here but is the residual behavior. Bundle the explicit pin into a future hygiene session if needed. |

## Verification

- `npx tsc --noEmit` clean on apps/api (0 errors).
- `npm test` in apps/api: **1724 tests across 93 files,
  0 failures**, 1435.48s. **Tenth consecutive fully-
  green full-suite run.**
- 24 new test cases.
- 2 production bug fixes (tenant-only check + PM
  ownership verify on confirm-setup).
- 0 production regressions.

## Items deferred — what S407 could target

### Medium-band batch remaining

After stripe.ts close (5 routes):
- **payments.ts — 4 routes (429 lines)**
- **reports.ts — 5 routes (489 lines)** — last
  medium-band file; financial-data scope; most likely
  to surface bugs.

Total remaining medium-band: **9 routes across 2 files.**

**Recommend S407 = payments.ts gap-close.** Smaller
file by 60 lines; then close S408 = reports.ts to
finish the route-test sweep arc.

### Validation-hygiene backlog (now 26 items)

Unchanged from S405.

### Pending Nic decisions

Unchanged.

### Per directive: fix all bugs before Checkr

Cumulative bug-sweep totals (post-S406):
- **42 production bug fixes** (+2 in S406)
- 26 architectural / validation findings flagged
- 1724 tests covering ~391 of 506 audited routes (77%)

## Items deferred (cross-session docket, post-S406)

Unchanged from S405.

## Nic-pending

Unchanged.

## What S407 should target

**Recommended: payments.ts gap-close** (4 routes, 429
lines). Then S408 = reports.ts (5 routes, 489 lines)
to close the route-test sweep arc.

**Alternatives:**
- reports.ts (5 routes, 489 lines — most bug potential)
- Validation-hygiene micro-session (26-item backlog +
  S398 product decisions)
- background.ts + Checkr (defer until route-test
  sweep closes)

---

End of S406 handoff. **stripe.ts arc CLOSED at 5/5
routes (100%).** Slice / 24 tests / 2 production bug
fixes on confirm-setup (tenant-only check + PM
ownership verify).

1724 tests / 93 files / 0 failures. Tenth consecutive
fully-green full-suite run.

**42 cumulative production bug fixes shipped across the
bug sweep.** Two files left in the route-test sweep
arc (payments.ts + reports.ts).
