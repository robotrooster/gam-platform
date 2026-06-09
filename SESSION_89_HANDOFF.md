# Session 89 Handoff

**Theme:** DEFERRED Item 5 — maintenance subsystem. 5 phantom tables
behind the maintenance-portal routes I gated in S81 are now real.
Same recipe that closed Item 6 work-trade in S88 — read what the
route assumes, write the migration to match, add the right CHECK
constraints + indexes + idempotency anchors.

## Architecture decision recorded

**One open shift per worker, enforced by partial UNIQUE.** The
maintenance-portal route already checks "are you already clocked in?"
before insert, but a race between two clock-in calls could double-
insert. Partial `UNIQUE INDEX shifts_one_open_per_user ON shifts(user_id)
WHERE clocked_out_at IS NULL` makes the DB the source of truth.
Historical shifts (clocked_out_at NOT NULL) are unbounded.

**Purchase requests can survive their work order.** `work_order_id`
on purchase_requests is `ON DELETE SET NULL` rather than CASCADE — a
deleted maintenance_request shouldn't wipe the supply purchase audit
trail. Same posture for `assigned_to` / `completed_by` user FKs across
the subsystem (workers leaving doesn't erase what they did).

**Recurrence vocabularies are CHECK-locked.** daily_tasks recurrence
matches the route's filter (`recurrence != 'none'`); scheduled_maintenance
recurrence matches the recurrenceMap in
`maintenance-portal.ts:198-200` exactly. Drift between schema and code
is a known landmine class — these CHECK constraints are the canary.

## Shipped

### Migration 20260503100000_maintenance_subsystem.sql

**`shifts`** — clock-in/clock-out timer.
- Columns: id, user_id, landlord_id, clocked_in_at (default NOW),
  clocked_out_at, notes, created_at.
- Indexes: partial UNIQUE on user_id WHERE clocked_out_at IS NULL;
  partial filter on (landlord_id, clocked_in_at ASC) WHERE
  clocked_out_at IS NULL for the active-shifts roster query.

**`daily_tasks`** — landlord-defined daily checklist items.
- Columns: id, landlord_id, title, description, assigned_to,
  due_date, recurrence, completed, completed_at, completed_by,
  timestamps.
- CHECK: recurrence ∈ (none/daily/weekly/monthly).
- Index on (landlord_id, completed, due_date) for the
  "today's tasks" route.

**`parts_inventory`** — landlord-owned spare parts catalog.
- Columns: id, landlord_id, name, description, sku, quantity,
  min_quantity, unit (default 'each'), location, cost, timestamps.
- Index on (landlord_id, name) for the alphabetical roster query.

**`purchase_requests`** — worker-initiated supply requests, landlord
approves/denies.
- Columns: id, landlord_id, requested_by, approved_by, approved_at,
  work_order_id (FK to maintenance_requests, nullable, SET NULL on
  delete), items jsonb, notes, total_estimate, budget_limit, status,
  created_at.
- CHECK: status ∈ (pending/approved/denied).
- Indexes on (landlord_id, status, created_at DESC) for dashboard list;
  partial on work_order_id WHERE NOT NULL for the work-order join.

**`scheduled_maintenance`** — recurring preventive maintenance.
- Columns: id, landlord_id, title, description, recurrence (NOT NULL),
  property_id, unit_id, assigned_to, next_due, last_completed,
  estimated_hours, timestamps.
- CHECK: recurrence ∈ (weekly/monthly/quarterly/biannual/annual) —
  exact match for the recurrenceMap in the route.
- Index on (landlord_id, next_due ASC) for the "upcoming" roster.

## Files touched

- apps/api/src/db/migrations/20260503100000_maintenance_subsystem.sql (new)
- apps/api/src/db/schema.sql (regenerated — 6237 → 6537 lines)
- DEFERRED.md (Item 5 marked SHIPPED)
- SESSION_89_HANDOFF.md (this file)

## Validation

- `npm run db:migrate` → 1 applied; schema.sql regenerated to 6537 lines
- All 5 tables confirmed via `psql gam -tAc "SELECT 1 FROM <tbl> LIMIT 1"`
- `cd apps/api && npx tsc --noEmit` → exit 0

## What this session did NOT do

- **No end-to-end smoke.** Schema matches route shape so the routes
  should function clean, but I didn't run a clock-in → daily-task →
  parts-add → purchase-request → approve chain. Worth manual
  verification when the maintenance UI is touched. Same caveat as
  S88 work-trade.
- **No frontend touched.** maintenance-portal endpoints exist, the UI
  that consumes them is its own scope.
- **No seed data.** Empty subsystem. The first landlord who configures
  it will populate parts_inventory + scheduled_maintenance from
  scratch.
- **No notifications wired.** A purchase_request hitting `pending`
  doesn't email the landlord; a `denied` doesn't email the requesting
  worker. Email templates would compose from the existing Resend
  helpers — straightforward follow-up when the UI surface is built.

## Phantom-table progress

After three consecutive subsystem migrations (S87 adverse-action,
S88 work-trade, S89 maintenance), the phantom-table inventory is:

- **POS (11 tables)** — Item 14, RV park use case
- **FlexCharge (2 tables)** — Stage-2 Flex Suite
- **utility_bills** — Item 10
- **books_access** — Item 3 (Books rebuild)

Down from 18 missing at the S85 audit. Two of the four remaining
groups (POS, Flex Suite) are explicitly product-tier multi-day
builds. Books and utility billing are the two that could still land
inside one focused session each.

## Pre-launch blockers still open

- Item 3 — Books rebuild (books_access + AZ-genericize + 5 broken
  endpoints).
- Item 10 — Utility billing subsystem.
- Item 11 — Master Schedule finish-or-strip (your product call).
- Item 14 — POS app completion (11 phantom tables, multi-day).
- Item 16 batch 2 — bank ACH origination provider selection.
- Item 16 batch 3+ — OTP enablement (FlexPay SetupIntent), pi_* audit.

## What next session should target

Top picks for S90:

1. **Item 10 — Utility billing (recommended).** Single utility_bills
   phantom + the billing math (RUBS allocation across occupants/sqft/
   bedrooms, sub-meter pulls, flat). Schema is small but allocation
   logic is the substance. Nic flagged at S60 as a launch differentiator
   — competing softwares fail at this. One focused session likely
   covers schema + generator + route.
2. **Item 11 — Master Schedule finish-or-strip.** 9 phantom cols across
   units + unit_bookings, vocabulary drift between units.ts:180-184 and
   SchedulePage.tsx (S63). Needs your product call: build out the
   booking-type matrix or rip the master-schedule UI.
3. **Item 3 — Books rebuild.** Bigger — books_access schema + bookkeeper
   signup flow + AZ-genericize + 5 broken endpoints. Dedicated session
   per S60 lock.

Recommend **#1**. Keeps the phantom-table-elimination momentum going,
and the pattern (schema migration + add minimal generator) matches
what just worked. Books rebuild is also bounded but bigger; saving it
for fresh context.
