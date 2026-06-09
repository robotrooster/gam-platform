# Session 128 Handoff

**Theme:** Sub-permission route gating — pass 3 (units.ts).
Continues S126/S127. Two unit-lifecycle routes opened to
property_manager workers; eviction-mode kept owner-only.

## Architecture decisions

**Activate = units.edit, not a new perm.** Activation flips a unit
to `status='active'` and kicks off billing, but operationally it's
a unit-state change with the same surface as `PATCH /:id/status`
(which has been `units.edit` since S81). Reusing `units.edit`
avoids catalog churn and matches landlord intent: the perm
"can change unit state" carries the activation gate too.

**cancel-scheduled-activation mirrors activate.** Same domain,
same perm.

**Eviction-mode stays owner-only.** It hard-blocks tenant ACH and
sets `payment_block` on the unit — high-stakes, legally fraught
(though no state-specific logic per CLAUDE.md). Kept on
`requireLandlord`. Future: maybe a dedicated `units.set_eviction_mode`
perm if a landlord wants to delegate this to a senior PM, but
that's a product call, not a mechanical swap.

**Two-layer auth: requirePerm (gate) + canManageLandlordResource
(scope).** Pattern preserved. `requirePerm('units.edit')` opens
the door for property_manager workers who hold the perm; then
`canManageLandlordResource(user, unit.landlord_id, ['property_manager'])`
verifies the worker is scoped to the landlord that owns the unit.
The team-role allowlist on the second call had to widen from `[]`
to `['property_manager']` — without that, the per-resource scope
check would still reject the worker even though requirePerm let
them through.

## Shipped

### apps/api/src/routes/units.ts

Two routes swapped:
- `POST /:id/activate` — `requireLandlord` →
  `requirePerm('units.edit')`; team-role allowlist widened to
  `['property_manager']`.
- `POST /:id/cancel-scheduled-activation` — same swap.

`POST /:id/eviction-mode` (line 125) intentionally unchanged.

## Files touched

- `apps/api/src/routes/units.ts` (2 perm gates + 2 scope-allowlist
  widenings)
- `SESSION_128_HANDOFF.md` (this file)

No migrations, no schema changes, no shared package changes, no
new helper imports.

## Validation

- `npx tsc --noEmit -p apps/api/tsconfig.json` → exit 0
- Manual review: only `/:id/eviction-mode` still references
  `requireLandlord` in units.ts (confirmed via grep — line 125).
- Pattern matches the rest of units.ts (PATCH /:id/status etc.
  already on `units.edit`).

Live API smoke deferred (dev server not running).

## What this session did NOT do

- **No swap on eviction-mode.** Stays owner-only by design.
- **No frontend.** Per UI/UX standing rule.
- **No catalog changes.** Reused existing `units.edit`.

## Pre-launch backend status

Add to closed list:
- ✅ Sub-permission gating — units activate / cancel-scheduled (2 routes)

Open items:
- Sub-permission gating — remaining ~15 routes:
  - `bulletin.ts/landlord` (1)
  - `notifications.ts/bulk` (1)
  - `workTrade.ts` (5 — needs catalog extension)
  - `books.ts/bookkeeper/*` (5 — likely stay owner-only)
  - `landlords.ts` remaining (~8 — most stay owner-only)
- Compliance-table retention policy (needs your retention windows)
- lease_fees move_out / other due_timing wire-up (product call)
- OTP enablement (Item 16 batch 3+ — needs FlexPay tier UX)
- Admin notification surface (long-standing deferral)
- Frontend pass for everything backend-ready
- Stripe sandbox testing (waiting on test API key)

## What next session should target

Continuing the sub-permission swap by domain:

1. **bulletin.ts/landlord + notifications.ts/bulk** — small
   pair. Both are landlord-broadcast surfaces. Likely
   `tenants.create` is too narrow; the cleaner answer is to
   add a new `notifications.send_bulk` perm to the catalog and
   gate both. Light catalog discussion + 2 swaps.
2. **workTrade.ts** — needs new perms (`work_trade.view`,
   `work_trade.reconcile`). Bigger pass.
3. **books.ts/bookkeeper management + landlords.ts financial** —
   final review pass; most stay owner-only.

Recommend **#1 (bulletin + notifications)** as next — small,
contained, but does require deciding whether to add a new
catalog perm. If you'd rather not touch the catalog mid-pass,
do **#3** instead (review + document, no swaps where things
should stay owner-only).
