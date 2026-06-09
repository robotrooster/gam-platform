# Session 153 Handoff

**Theme:** Early-termination flow shipped end-to-end (the 2B path).
Tenant initiates → fee auto-charged via on-file Stripe payment
method → lease flips to terminated. Landlord can waive in good
faith. Three fee bases supported: lease-specific, landlord-default
(months × rent), no-policy.

## Decisions captured (from earlier turn)

- **Q1 B**: dedicated `lease_termination_requests` audit table
- **Q2 C**: prominent button on tenant /lease page + confirmation
  modal with fee + "I understand" checkbox before charging
- **Q3 C**: landlord-configured default policy (months of rent)
  used when no lease-specific fee on file
- **Q4 A**: lease flips immediately to `terminated`; move-out
  workflow runs separately (S152 deposit-return)

## Items shipped

### Migration: `lease_termination_requests` + landlord default

```
20260506110000_lease_termination_requests.sql
```

- New `lease_termination_requests` table with full audit trail
  (requested_at, requested_by, reason, fee_amount snapshot,
  fee_basis, charge attempt status, waiver, terminated_at,
  status lifecycle).
- New column `landlords.default_early_termination_months_rent`
  (nullable numeric).
- Partial UNIQUE INDEX preventing duplicate active requests
  per lease (excludes terminal statuses).

### Service: `services/leaseTermination.ts`

- `quoteFee(leaseId)` — three-tier priority: lease_specific →
  landlord_default → no_policy. Returns amount + basis +
  multiplier metadata for the UI.
- `requestEarlyTermination({leaseId, tenantId, requestedByUserId, reason?})`
  — creates the request row; for fee>0 attempts off-session
  Stripe charge against tenant's default payment method; for
  fee==0 (no_policy) flips to `fee_waived` + `terminated`
  immediately.
- `waiveFeeAndTerminate({requestId, waivedByUserId, reason?})`
  — landlord override path. Bypasses charge, terminates lease.
  Allowed while status is `requested` or `failed`.
- `cancelRequest(requestId)` — tenant cancellation pre-finalize.
- `terminateInTx` (internal) — flips lease.status='terminated',
  cascades lease_tenants → removed, vacates unit, stamps
  `terminated_at` on the request, emits credit-ledger events
  on both tenant + landlord subjects.

Credit-ledger events emitted:
- `lease_terminated_early_by_tenant` — fee paid path (rare in
  v1 since dev tenants have no Stripe customer; production
  tenants will trigger this)
- `lease_terminated_early_by_landlord` — waiver path
- `lease_terminated_early_by_tenant` (with `no_policy: true` in
  event_data) — no_policy path

### Routes (in `routes/leases.ts`)

```
GET  /api/leases/:id/termination-quote        — preview fee
POST /api/leases/:id/terminate-early          — tenant initiates
POST /api/leases/:id/waive-early-termination  — landlord waives
POST /api/leases/:id/terminate-early/cancel   — tenant cancels
```

`PATCH /api/landlords/me` extended to accept
`defaultEarlyTerminationMonthsRent` (null clears the field;
omitted preserves prior).

### Tenant UI

`apps/tenant/src/pages/LeasePage.tsx` — added an
`EarlyTerminationSurface` component nested in the page header.
- "End lease early" button shown on active/pending leases that
  have been fully executed
- Click → modal with fee summary, basis explanation, optional
  reason textarea, "I understand" checkbox (gates the
  Pay & Terminate button when fee > 0)
- Pending request state: shows "Termination pending" /
  "failed — retry" badge with cancel link
- Result state: shows the outcome inline (paid / failed / no
  charge needed)

### Landlord UI

- New page `/leases/:id/termination` (`LeaseTerminationPage.tsx`)
  showing the policy summary + existing request status. When a
  request is `requested` or `failed`, a "Waive fee & terminate"
  panel appears with mandatory reason textarea.
- `SettingsPage.tsx` — new "Default Early-Termination Policy"
  card with a months-of-rent input. Save button now requires
  any change (threshold or policy) to enable.

## Files touched / created

```
apps/api/src/db/migrations/20260506110000_lease_termination_requests.sql  (new)
apps/api/src/db/schema.sql                                                 (regenerated)

apps/api/src/services/leaseTermination.ts                                  (new — 410 lines)
apps/api/src/routes/leases.ts                                              (4 termination endpoints appended)
apps/api/src/routes/landlords.ts                                           (PATCH /me extended)

apps/landlord/src/pages/LeaseTerminationPage.tsx                           (new — 180 lines)
apps/landlord/src/pages/SettingsPage.tsx                                   (default-policy card)
apps/landlord/src/main.tsx                                                 (route)

apps/tenant/src/pages/LeasePage.tsx                                        (EarlyTerminationSurface inline component)
```

## Validation

- `npm run db:migrate` → 1 applied
- `npx tsc --noEmit` on api / landlord / tenant / admin → all exit 0
- Live smoke (6 phases, all passing):
  - Phase 1: `quoteFee` with lease_specific fee = $2000 ✓
  - Phase 2: `requestEarlyTermination` — charge fails as
    expected (no Stripe customer in dev), status flips to
    `failed` ✓
  - Phase 3: `waiveFeeAndTerminate` flips status to `fee_waived`,
    lease.status to `terminated`, both tenant + landlord credit
    events emitted ✓
  - Phase 5: `quoteFee` with landlord_default 1.5× rent =
    $2250, basis=landlord_default ✓
  - Phase 6: `quoteFee` with no policy = $0, basis=no_policy;
    `requestEarlyTermination` skips charge and flips to
    `fee_waived` immediately ✓

A real bug was caught and fixed during smoke: the no_policy path
was creating the request row but not flipping its status, leaving
it stuck in `requested`. Fixed inline.

## What this session did NOT do

- No linkage between the lease detail row (LeasesPage) and the
  new `/leases/:id/termination` page. Landlord reaches the
  page only via direct URL or the notification deep-link.
  Adding a row action (similar to the Move-out button) is a
  small follow-up.
- No notification emit when a termination request lands or is
  resolved. The S139 notification framework is in place; just
  need to call the appropriate `notify*` helpers from the
  service. Follow-up.
- No "scheduled" termination — every termination is immediate
  upon fee paid/waived. If product wants "terminate effective
  end-of-month," that's a future enhancement.
- No tenant retry UX on the "failed" state. Tenant currently
  sees "failed — retry" link but the retry path requires
  cancelling and re-initiating. Could add an explicit retry
  button.

## Pre-launch backend status

Closed list updates:
- ✅ Early-termination flow with fee auto-charge + waiver path (2B)
- ✅ Three-tier fee policy (lease / landlord-default / no-policy)
- ✅ Landlord default-policy setting on Settings page

Remaining `due_timing` items:
- `other_fee` per-fee due_timing picker (3C) — small UI
  addition. Next session.

Other open items unchanged (PM, OTP, tax catalog, Stripe sandbox,
live walkthrough).

## What next session should target

**Session 154: `other_fee` per-fee `due_timing` picker (3C)**

Smallest piece left in the due_timing wire-up. The
`other_fee` row currently hardcodes its `due_timing` to
`'other'` in `FEE_ROW_SPECS` (shared package). Per the locked
3C answer, the landlord should be able to pick
`move_in / monthly_ongoing / move_out / other` for each
`other_fee` row when they create the lease. UI surface lives
in the lease creation flow (probably the lease document
template builder or the lease form modal).

Plain-English design questions ahead: where does the picker
live in the UI, and does it need to surface on existing leases
too (PATCH path) or only at create time?

## Notes for future-Claude

- `lease_termination_requests.fee_amount` is the SNAPSHOT at
  request time. If landlord later changes the default policy,
  the in-flight request keeps the original amount. That's
  intentional — frozen at request prevents mid-flight policy
  changes.
- The Stripe charge in `requestEarlyTermination` uses the
  same `off_session: true, confirm: true` pattern as the S152
  deposit-return gap charge. Same caveat: the resulting
  PaymentIntent's id isn't stored in the GAM payments row
  — webhook matches on `metadata.gam_payment_id` instead.
  Both flows have this known gap and will resolve via the
  same future cleanup.
- The waiver path requires a non-empty reason in the UI but
  the backend allows blank. UI is the gate; if a waiver row
  is needed without UI involvement, the backend permits it.
- `terminateInTx` always emits the same event_type to both
  tenant AND landlord subjects. The dimension tags are
  `['tenancy_stability']` for both. Network visibility differs:
  tenant gets `visible_to_gam_network` (negative event), landlord
  gets `visible_to_current_landlord` (operational).
- The smoke runner caught a real status-flip bug in the
  no_policy path. Fixed inline. The fix sets
  `fee_waiver_reason='no_policy_on_file'` so the audit trail
  distinguishes "explicit landlord waiver" from "automatic no-fee
  pass-through." If you ever query `fee_waived_by_user_id IS
  NULL`, those are the no_policy auto-waivers.
