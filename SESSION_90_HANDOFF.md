# Session 90 Handoff

**Theme:** DEFERRED Item 10 — utility billing subsystem. The phantom
utility_bills table now exists; the generation engine (submeter / RUBS
/ master) is wired; the landlord-side meter management surface
expanded from one route stub to 11 endpoints. Payment integration
(rolling utility charges into rent collection) is the remaining leg
and is deferred until the bank ACH rail decision lands.

## Architecture decision recorded

**Three billing methods, one engine.** The existing
`utility_meters.billing_method` CHECK already declared
`submeter | rubs | master_bill_to_landlord`. The new generation engine
in `services/utilityBilling.ts` honors all three:
- **submeter** — usage = (current cycle reading − prior cycle reading),
  charge = usage × rate + base fee. First cycle has no prior reading so
  produces no bill (no baseline yet).
- **RUBS** — one master meter, multiple units, split by
  `rubs_allocation_method` ∈ (occupant_count | sqft | bedrooms |
  equal_split). Per-unit share = (unit basis / total basis) of
  (total usage × rate + total base fee). Handles zero-basis units
  cleanly (skip rather than divide-by-zero).
- **master_bill_to_landlord** — landlord absorbs, no tenant bills.

**Snapshots, not derived values.** `utility_bills` freezes
`allocation_method`, `allocation_basis`, `rate_per_unit`, and
`base_fee_share` at generation time. A meter rate change next month
won't retroactively rewrite last month's bills. Same posture as the
auto-Friday payout snapshot (S66) and the disbursement firing snapshot
(S78).

**Idempotency at the DB.** `UNIQUE (meter_id, unit_id, billing_cycle_
month)` makes bill generation safe to re-run. The engine catches
`23505` and skips silently — landlord can hit "Generate Bills" twice
on the same cycle without doubling. Same pattern as
background_checks.applicant_payment_intent_id (S83).

**Tenant responsibility gates per-lease.** Even when a meter is
assigned to a unit and a reading exists, no bill is produced unless
`lease_utility_responsibilities.tenant_responsible = TRUE` for that
lease + utility type. Landlord can carry one utility (e.g., trash) for
all units while tenants carry water. The existing 5-utility-type
CHECK enum (water/gas/electric/sewer/trash) constrains both sides.

**No platform-side legal commentary.** No caps, no state-rate
overlays, no "max admin fee" enforcement. Landlords set their own
rates and responsibility splits. Per the GAM "no state-specific legal
logic" rule.

## Shipped

### Migration 20260503110000_utility_bills.sql
- `utility_bills` table: id, meter_id, unit_id, tenant_id, lease_id,
  landlord_id, billing_cycle_month, usage_amount,
  allocation_method/basis (snapshot), rate_per_unit (snapshot),
  base_fee_share, charge_amount, status, billed_at, paid_at,
  payment_id (nullable FK to payments), notes, timestamps.
- CHECK: status ∈ (unbilled / billed / paid / disputed / void).
- UNIQUE (meter_id, unit_id, billing_cycle_month) — idempotency anchor.
- Indexes: (landlord_id, billing_cycle_month DESC) for landlord
  dashboard; (tenant_id, billing_cycle_month DESC) for tenant view;
  partial on status='unbilled' for the next-action cron.

### apps/api/src/services/utilityBilling.ts (new)
- `generateBillsForMeter(meterId, cycleMonth)` — single-meter engine.
  Handles all three billing methods. Returns
  `{ meterId, cycleMonth, billsCreated, unitsSkipped, reason? }`
  for observability.
- `generateBillsForProperty(propertyId, cycleMonth)` — fan-out to all
  meters on a property.
- `generateBillsForLandlord(landlordId, cycleMonth)` — fan-out across
  all properties under a landlord.
- Internal `tryInsertBill()` does the per-unit work: looks up the
  active primary tenant via `v_lease_active_tenants`, gates on
  `lease_utility_responsibilities`, INSERTs the row, swallows 23505
  for safe re-runs.

### apps/api/src/routes/utility.ts (rewritten)
Expanded from one stub endpoint to 11:
- `GET /bills` — refined with proper role-based scoping (tenant own,
  landlord own, scoped worker via `landlordId`, admin all).
- `GET /meters` — landlord meter roster with unit count + last reading
  cycle (partial perm gate: `units.edit / units.view_status /
  properties.edit`).
- `POST /meters` — create meter with RUBS/non-RUBS validation matching
  the existing `utility_meters_check` constraint.
- `PATCH /meters/:id`, `DELETE /meters/:id` — edit/remove. Delete is
  RESTRICT-blocked if any utility_bills reference the meter (legal
  record protection); 23503 gets a clean 409 message.
- `POST /meters/:id/units`, `DELETE /meters/:id/units/:unitId` — meter
  ↔ unit assignment.
- `GET /meters/:id/readings`, `POST /meters/:id/readings` — reading
  list and entry.
- `POST /generate-bills` — landlord-triggered generation. Accepts
  `meterId`, `propertyId`, or no scope (defaults to landlord-self).
  Returns the per-meter result array.

All landlord-side endpoints use the S81 `requirePerm` pattern; the
in-handler `canAccessLandlordResource` enforces landlord ownership of
the resource.

## Files touched

- apps/api/src/db/migrations/20260503110000_utility_bills.sql (new)
- apps/api/src/db/schema.sql (regenerated — 6537 → 6651 lines)
- apps/api/src/services/utilityBilling.ts (new)
- apps/api/src/routes/utility.ts (rewritten — was 21 lines, now ~250)
- DEFERRED.md (Item 10 marked PARTIAL with payment integration deferred)
- SESSION_90_HANDOFF.md (this file)

## Validation

- `npm run db:migrate` → 1 applied; schema.sql regenerated to 6651 lines
- `psql gam -c "\\d utility_bills"` confirms columns + indexes +
  UNIQUE constraint
- `cd apps/api && npx tsc --noEmit` → exit 0

## What this session did NOT do

- **No payment integration.** `utility_bills.payment_id` is nullable
  and ready, but nothing yet rolls a `billed` utility row into a rent
  payment or initiates its own ACH pull. Two design options for the
  next session: (A) add utility charge as a line item on the next
  rent payment, or (B) initiate utility as a separate ACH on a fixed
  monthly date (15th was the original cron timing). Option B requires
  bank ACH rail (Item 16 batch 2). Defer the decision until then.
- **No frontend.** Landlord meter-management UI + tenant bill view
  page are scope for separate UI sessions. The endpoints exist and
  are perm-gated.
- **No monthly cron to auto-generate bills.** The 15th-of-month cron
  was deleted in S86 because it was a pure log statement with no
  engine. Re-add when payment integration lands so generation +
  collection happen as one orchestrated step.
- **No end-to-end smoke with real readings.** Schema + engine logic
  verified by inspection; no test SQL inserts a meter → reading →
  generate cycle. Worth manual verification via `psql` + `curl` when
  the UI work begins.

## Phantom-table progress

After S90, the inventory is:
- **POS (11 tables)** — Item 14, RV park use case (multi-day)
- **FlexCharge (2 tables)** — Stage-2 Flex Suite
- **books_access** — Item 3 (Books rebuild)

Down from 18 missing at the S85 audit (12 closed across S87/S88/S89/S90).

## Pre-launch blockers still open

- Item 3 — Books rebuild (books_access + AZ-genericize + 5 broken
  endpoints).
- Item 11 — Master Schedule finish-or-strip (your product call).
- Item 14 — POS app completion (11 phantom tables, multi-day).
- Item 16 batch 2 — bank ACH origination provider selection.
- Item 16 batch 3+ — OTP enablement (FlexPay SetupIntent), pi_* audit.
- Item 10 (this session) payment integration — gated on Item 16 batch 2.

## What next session should target

Top picks for S91:

1. **Item 3 — Books rebuild (recommended).** Last bounded subsystem
   build before the multi-day items (POS, Stripe rail). Three
   workstreams per S60 lock: books_access schema + bookkeeper signup
   flow + landlord invite UI; AZ-genericize (rename
   az_withholding_pct → state_withholding_pct, strip AZ-prefix UI
   labels, configurable per-state rate); 5 broken bookkeeper
   endpoints. Could span 1-2 sessions depending on how deep the
   bookkeeper signup flow goes.
2. **Item 11 — Master Schedule finish-or-strip.** 9 phantom cols.
   Needs your product call: build the booking-type matrix or rip
   the master-schedule UI. Half-day either way once the call is made.
3. **Wire the POS gating-only routes to actual data.** Item 14 is
   multi-day for the full subsystem, but a smaller session could
   stub `pos_items` etc. as schema-only the way work-trade and
   maintenance landed in S88/S89. Half-to-full day if scoped tight.

Recommend **#1**. It's the last bounded subsystem and finishes the
phantom-table elimination work that's been the through-line for
S87→S90. After Books rebuild, only Stage-2 (FlexCharge) and product-
tier multi-day items remain.
