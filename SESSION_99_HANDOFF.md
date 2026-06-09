# Session 99 Handoff

**Theme:** POS data-path hardening. Two narrow guards in one
migration — non-negative stock_qty CHECK on items + variants, and
a BEFORE UPDATE trigger that auto-logs price_history on every
sell_price/cost_price change. Route's inline INSERT removed (now
redundant).

## Architecture decision recorded

**DB-side guards over application-side guards.** Pre-S99 the route
relied on `Math.max(0, stock_qty - qty)` to keep stock non-negative.
That clamp silently masks oversells — cashier rings up 5 of an item
that has 3 in stock, the route quietly zeros the count and proceeds.
The new CHECK constraint enforces non-negative at the DB so any path
(this route, future routes, direct SQL, seed scripts, bulk imports)
gets a hard reject on negative writes. The existing route's clamp
keeps the route working unchanged — the CHECK is a backstop, not a
behavior change for the existing call site.

**Trigger over inline INSERT for price_history.** Same posture.
Pre-S99 only `PATCH /api/pos/items/:id` knew to write a
pos_price_history row when sell_price or cost_price changed. Future
SQL writes, future bulk-edit endpoints, future seed scripts all
silently bypassed the audit. The BEFORE UPDATE trigger moves the
responsibility into the DB; the route's inline INSERT becomes
redundant and was deleted.

**Actor capture via session GUC, not trigger argument.** The trigger
needs to record `changed_by` (the user who initiated the change).
PostgreSQL triggers can't take arguments at fire-time, so the route
sets a session-local GUC (`gam.user_id`) before the UPDATE; the
trigger reads it via `current_setting('gam.user_id', true)`. Direct
SQL writes leave the GUC unset → `changed_by` is NULL — by design.
A NULL actor is recoverable forensic info ("we don't know who, but we
have the values"); a missing row is not.

## Shipped

### Migration 20260503170000_pos_stock_guards_and_price_trigger.sql

- `ALTER TABLE pos_items ADD CONSTRAINT pos_items_stock_qty_nonneg
  CHECK (stock_qty >= 0)`
- `ALTER TABLE pos_item_variants ADD CONSTRAINT
  pos_item_variants_stock_qty_nonneg CHECK (stock_qty >= 0)`
- New `fn_pos_items_log_price_change()` function with EXCEPTION
  block around the GUC read so missing/invalid `gam.user_id`
  resolves to NULL rather than aborting the UPDATE.
- New `pos_items_price_history_trg` BEFORE UPDATE trigger; fires
  only when sell_price OR cost_price changed (`IS DISTINCT FROM`).

### apps/api/src/routes/pos.ts

- `PATCH /items/:id` — inline INSERT into pos_price_history removed
  (trigger handles it). Replaced with `SELECT set_config('gam.user_id',
  $userId, true)` so the trigger has the actor.

## Files touched

- apps/api/src/db/migrations/20260503170000_pos_stock_guards_and_price_trigger.sql (new)
- apps/api/src/db/schema.sql (regenerated, 7439 → 7478 lines)
- apps/api/src/routes/pos.ts (inline INSERT removed, GUC set instead)
- SESSION_99_HANDOFF.md (this file)

DEFERRED.md not edited — this is hardening, not a tracked DEFERRED
item.

## Validation

- `npm run db:migrate` → 1 applied; schema.sql regenerated to 7478 lines
- `cd apps/api && npx tsc --noEmit` → exit 0
- SQL smoke walk inside a rolled-back transaction:
  - Negative stock_qty UPDATE → CHECK rejects (rolled back via
    SAVEPOINT)
  - Sell price change with GUC set → history row written with actor
  - Cost-only change → history row written
  - Non-price change (icon update) → history count unchanged
  - All assertions matched expected behavior

## What this session did NOT do

- **No route-side oversell handling.** The route's `Math.max(0, ...)`
  still clamps quietly. The CHECK only fires if some other path tries
  to write negative — not the existing happy-path. Surfacing oversells
  as a 400 "out of stock" to the cashier is a separate UX decision
  (not in scope here; CHECK is the structural guard).
- **No backfill for orphan price changes.** Pre-trigger price changes
  not in pos_price_history stay missing. New changes from now on are
  always logged.
- **No application of the same pattern to other tables.** Same
  invariants exist on:
    - `pos_purchase_order_items.qty_ordered` (>= 0?)
    - `parts_inventory.quantity` (>= 0)
    - any other inventory-style column
  Worth a separate audit pass; not in S99 scope.

## Pre-launch blockers still open

- Item 16 batch 2 — bank ACH origination provider (Monday).
- Item 16 batch 3+ — OTP enablement (FlexPay SetupIntent).
- Item 10 (S90) payment integration — gated on Item 16 batch 2.

## What next session should target

This is a good stop point for this conversation. Context has been
loaded across 13 sessions (S87 → S99); recommend opening fresh chat
on Monday with ACH info in hand and reading the latest handoff.

Top picks for S100 (fresh chat):

1. **Item 16 batch 2 — bank ACH origination provider**, the moment
   you've picked the rail. `services/disbursementFiring.ts:fireViaBankAch`
   swap the throw, set `DISBURSEMENT_RAIL=bank_ach`, wire the
   settlement webhook.
2. **Item 10 utility billing payment integration** — utility_bills
   (S90) into the rent payment flow. Decision: line item on next rent
   ACH vs separate cycle pull. Constrained by which rail you pick.
3. **Same stock_qty/price_history pattern for parts_inventory.quantity
   and pos_purchase_order_items.qty_ordered** — quarter-day audit
   pass extending S99 hardening to sibling tables.

Recommend **#1** if you've made the rail call. Without it, blockers
keep accumulating gated work.
