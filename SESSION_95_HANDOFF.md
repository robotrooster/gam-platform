# Session 95 Handoff

**Theme:** POS end-of-day reconciliation. Closes the cashier's day per
(landlord, business_day) with cash/card/charge totals + refund deltas
+ cash-drawer expected vs actual + variance. Daily cron auto-closes
yesterday at 3:30am Phoenix; cashiers can manually close earlier with
a drawer count via `POST /api/pos/eod/close`. Idempotent re-runs via
UNIQUE.

## Architecture decision recorded

**Phoenix-local business day boundary.** Per CLAUDE.md the platform's
canonical timezone is America/Phoenix (no DST year-round). Day window
is computed in the SQL as `'YYYY-MM-DD 00:00:00 America/Phoenix'` to
`+1 day`, so a 2am-Phoenix sale rolls into the previous business day's
settlement. Same convention as the auto-payout cron (S66).

**Cash-drawer math lives in generated columns.** The table stores
`opening_float` + `cash_drawer_actual` (cashier-entered) directly,
and computes `cash_drawer_expected` (= opening_float + cash_sales −
cash_refunds) and `cash_drawer_variance` (= actual − expected) as
STORED generated columns. Math stays in one place; whether the row
came from the auto-cron or a manual close, the variance is computed
the same way. `actual` is NULL on auto-close → variance NULL.

**Three statuses.**
- `auto_closed` — cron ran, cashier hasn't manually counted the
  drawer. drawer_actual is NULL, variance is NULL.
- `manually_closed` — cashier ran POST /eod/close with a drawer
  count. drawer_actual stamped, variance computed.
- `reopened` — admin override after late-arriving txns/refunds. The
  regenerate endpoint refreshes totals + flips status to flag the row
  as recomputed after the original close window.

**Idempotency at the DB.** UNIQUE (landlord_id, business_day) makes
re-running the engine safe. The service uses `INSERT ... ON CONFLICT
UPDATE` to refresh totals on second-run; the COALESCE on
`cash_drawer_actual` and `closed_by` preserves the cashier's manual
close even if the cron retries afterward (cron pass writes NULL,
COALESCE keeps the existing non-NULL).

**Cron skips zero-activity landlords.** `generateEodForAllActiveLandlords`
unions DISTINCT landlord_id from pos_transactions and pos_refunds for
the day; if a landlord had no POS activity, no settlement row gets
written. Avoids filling pos_eod_settlements with empty rows for
landlords who don't run POS at all.

## Shipped

### Migration 20260503160000_pos_eod_settlements.sql
Single table:
- Per-payment-method totals (cash/card/charge sales + refunds)
- Aggregates: tax_collected, surcharge_collected, platform_fee_total
- Counts: tx_count (completed + refunded + partial_refund),
  refund_count, voided_count
- Cash drawer: opening_float (input), cash_drawer_actual (input,
  nullable), cash_drawer_expected (generated), cash_drawer_variance
  (generated)
- status CHECK (auto_closed / manually_closed / reopened)
- closed_at, closed_by (FK users, SET NULL on delete), notes
- UNIQUE (landlord_id, business_day) — idempotency
- Index (landlord_id, business_day DESC) for the recent-history view

### apps/api/src/services/posEod.ts (new)
- `generateEodSettlement(landlordId, businessDay, opts)` — sums
  pos_transactions + pos_refunds within the Phoenix-local day window,
  upserts pos_eod_settlements with INSERT ... ON CONFLICT UPDATE.
  COALESCE preserves manually-entered drawer count + closed_by on
  cron re-runs.
- `generateEodForAllActiveLandlords(businessDay)` — fan-out for the
  daily cron. UNIONs DISTINCT landlord_ids from txns + refunds for the
  day; iterates and calls generateEodSettlement per landlord.

### apps/api/src/routes/pos.ts (4 new endpoints)
- `GET /api/pos/eod` — recent settlements (default limit 30, max 90)
- `GET /api/pos/eod/:date` — single by YYYY-MM-DD
- `POST /api/pos/eod/close` — manual close. Body: `{ businessDay,
  cashDrawerActual, openingFloat?, notes? }`. Stamps the cashier as
  closed_by, sets status='manually_closed'.
- `POST /api/pos/eod/regenerate` — admin override. Re-derives totals
  (picks up late-arriving txns), flips status='reopened'.

All four gated on the existing `pos.end_of_day` permission key from
S81 catalog. Read endpoints also accept `pos.ring_sale` (cashier sees
their own day's close).

### apps/api/src/jobs/scheduler.ts
- New cron at `30 3 * * *` America/Phoenix — auto-closes yesterday
  for every landlord with POS activity. Computes "yesterday" via
  `(NOW() AT TIME ZONE 'America/Phoenix')::date - 1` so the JS-side
  date math doesn't drift from the engine's day-window math.
- Boot summary console.log updated to list the new cron.

## Files touched

- apps/api/src/db/migrations/20260503160000_pos_eod_settlements.sql (new)
- apps/api/src/db/schema.sql (regenerated, 7366 → 7439 lines)
- apps/api/src/services/posEod.ts (new)
- apps/api/src/routes/pos.ts (4 new endpoints appended)
- apps/api/src/jobs/scheduler.ts (new cron + summary line)
- SESSION_95_HANDOFF.md (this file)

## Validation

- `npm run db:migrate` → 1 applied; schema.sql regenerated to 7439 lines
- `cd apps/api && npx tsc --noEmit` → exit 0
- SQL smoke walk:
  - 3 transactions on 2026-05-02 (cash $50, card $30, charge $20) +
    1 cash refund of $5 + 1 out-of-day tx ($100 on 2026-05-03)
  - Settlement insert summed correctly: cash_sales=50, card_sales=30,
    charge_sales=20, cash_refunds=5, tx_count=3 (out-of-day tx
    excluded), expected drawer = $100 float + $50 cash − $5 refund =
    $145, actual + variance NULL (auto-close path)
  - Rollback verified

## What this session did NOT do

- **No frontend.** Cashier "close my day" UI + variance display + day
  history table are all UI work; the four new endpoints are ready
  to consume.
- **No drawer-count audit log.** If a manual close needs to be
  amended (cashier miscounted), today's path is regenerate (which
  loses the original count). A future enhancement could log every
  drawer_actual entry in a child table for full audit. Defer until
  the cashier UX surfaces the need.
- **No multi-terminal awareness.** This closes per (landlord, day),
  not per (landlord, terminal, day). When multi-terminal sync lands,
  the table picks up a `terminal_id` column. Until then, all
  transactions for a landlord on a day roll into one settlement.
- **No payout integration.** The settlement is a reporting artifact;
  it doesn't trigger anything downstream. When card sales need to
  flow into the auto-payout engine (S66), the join key is the
  stripe_payment_intent_id we added in S94.
- **No backfill.** Pre-S95 there are no settlements; first cron fire
  lands the first row. If you want historical days closed, run the
  regenerate endpoint per (landlord, date) you care about.

## Pre-launch blockers still open

- Item 16 batch 2 — bank ACH origination provider (Monday).
- Item 16 batch 3+ — OTP enablement (FlexPay SetupIntent).
- Item 10 (S90) payment integration — gated on Item 16 batch 2.

## What next session should target

Top picks for S96 (still no ACH info until Monday):

1. **npm audit + landlord unused-locals cleanup.** 4 vulnerabilities
   (uuid, node-cron, svix, resend major-version bumps) plus ~20
   noUnusedLocals strict-mode hits on landlord per DEFERRED smaller
   items. Bundled half-day. No product decisions.
2. **POS price_history triggers + stock_qty NEVER negative guards.**
   Route currently does `Math.max(0, stock_qty - qty)` which silently
   masks oversells. Add CHECK + a trigger to auto-write price_history
   on pos_items.sell_price/cost_price change. Quarter day.
3. **Marketing site copy review** — DEFERRED Item 4. Strip "Built
   for Arizona landlords" / "AZ-compliant lease templates" / Phoenix-
   Tucson-Mesa testimonials per the no-state-specific-logic rule.
   Half day, frontend, no engineering.

Recommend **#1**. Pure cleanup, zero decisions, knocks down both the
audit vuln count and the lingering strict-mode debt. #2 is good
hardening but lower urgency. #3 needs product/copy direction beyond
just stripping.
