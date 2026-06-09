# Session 93 Handoff

**Theme:** DEFERRED Item 14 (schema portion) — POS subsystem. 13
phantom tables behind the 33 pos.ts endpoints I gated in S81 are now
real. The largest single-feature schema gap on the board, closed in
one focused migration. Receipt printing / EOD / hardware integration
still product work for separate sessions.

## Architecture decision recorded

**Two transaction flows in one schema.** RV park use case requires
both walk-up (cash/card from non-tenants) and tenant-charge (post to
their account) flows. `pos_transactions.tenant_id` is nullable —
walk-up transactions have no tenant; charge transactions do. The
`payment_method` CHECK enforces (cash|card|charge); the platform fee
calculation in pos.ts treats `charge` as a 1% surcharge over subtotal.

**Snapshot line items survive parent delete/rename.**
`pos_transaction_items.item_name` and `item_category` are stored
verbatim at sale time. If a landlord renames or deletes a catalog
item later, every historical receipt still reads correctly. The
`item_id` FK is `ON DELETE SET NULL` — relationship preserved when
possible, name field is the source of truth either way. Same posture
as work-trade S88 logs and utility_bills S90 snapshots.

**Inventory log is the audit truth.** Every change to
`pos_items.stock_qty` is mirrored into `pos_inventory_log` with
before/after values, the reason (adjustment / sale / po_received /
return / manual / other), and a generic `reference_id` pointing at
the originating transaction or purchase order. The reference is a
uuid with no FK — by design, since it points at multiple parent
tables. The reason CHECK constrains the enum.

**Coded discounts unique per landlord; uncoded promos unbounded.**
Partial `UNIQUE(landlord_id, code) WHERE code IS NOT NULL` on
pos_discounts. A landlord can have many "Senior 10% off" promos
(no code, applied at cashier discretion) but a coded discount
("SAVE10") must be unique within their account.

**PO numbers unique per landlord.** `UNIQUE(landlord_id, po_number)`
on pos_purchase_orders. The route generates `PO-<base36-timestamp>`
which is collision-resistant in practice; the constraint backstops
in case two carts auto-draft from the same low-stock event in the
same millisecond.

## Shipped

### Migration 20260503140000_pos_subsystem.sql

**13 tables created:**

Catalog tier:
- `pos_vendors` — supplier catalog
- `pos_categories` — landlord-defined product categories with
  sort_order
- `pos_items` — product catalog with cost/sell prices, margin,
  tax_rate, stock_qty/min/max, vendor_id link, charge_eligible
  flag, has_variants flag
- `pos_item_variants` — sub-SKUs (e.g., propane size variants)
  CASCADE on pos_items delete
- `pos_price_history` — append-only price/cost change log
- `pos_tax_rates` — landlord tax rate config (multiple per landlord
  for sales/excise/lodging/etc.)
- `pos_discounts` — promo + coded discounts

Transaction tier:
- `pos_transactions` — header row with subtotal/tax/surcharge/total,
  payment_method CHECK, status CHECK, refund tracking
- `pos_transaction_items` — per-line snapshots
- `pos_refunds` — full + partial refunds (multiple per transaction)

Inventory tier:
- `pos_inventory_log` — audit of every stock_qty mutation

Purchasing tier:
- `pos_purchase_orders` — status flow draft → approved → sent →
  received → cancelled, with timestamp per transition
- `pos_purchase_order_items` — line items, CASCADE on PO delete

**Indexes** tuned for each route's actual query: low-stock partial
on pos_items, landlord+date DESC on transactions/refunds/inventory_log,
tenant+date partial on transactions where tenant_id NOT NULL,
po+vendor+status compound for the PO dashboard.

### No code changes required

Pre-S93 audit confirmed the 33 pos.ts endpoints (gated in S81) write
the exact column names this migration creates. Same posture as S92
master-schedule — the route file was always correct; the schema is
what's been wrong.

## Files touched

- apps/api/src/db/migrations/20260503140000_pos_subsystem.sql (new)
- apps/api/src/db/schema.sql (regenerated — 6681 → 7358 lines)
- DEFERRED.md (Item 14 marked PARTIAL with shipped + outstanding split)
- SESSION_93_HANDOFF.md (this file)

## Validation

- `npm run db:migrate` → 1 applied; schema.sql regenerated to 7358 lines
- All 13 tables confirmed via `SELECT 1 FROM <tbl> LIMIT 1`
- `cd apps/api && npx tsc --noEmit` → exit 0

## What this session did NOT do

- **No receipt printing.** ESC/POS hardware adapter is a separate
  build with its own product surface (printer config per terminal,
  receipt templates, etc.). The transaction data is structured to
  drive a printer when one shows up; the wiring isn't here.
- **No end-of-day reconciliation cron.** A daily roll-up that closes
  the cash drawer and reconciles cash/card totals against
  pos_transactions is straightforward to add now that the data
  exists. Defer until the cashier UI is in shape.
- **No Stripe Terminal hookup.** `terminal.ts` (S81-gated) creates
  PaymentIntents but doesn't yet record-back into pos_transactions
  on capture. One hop from real — small wiring session.
- **No end-to-end smoke.** Schema matches route shape so endpoints
  should function clean, but I didn't run a sale → inventory delta →
  low-stock → auto-PO chain. Worth manual smoke when the cashier UI
  is touched. Same caveat as S88/S89/S92.
- **No frontend.** POS app (port 3005 per CLAUDE.md) is its own
  multi-day product surface.

## Phantom-table progress

After S93, the inventory is:
- **FlexCharge (2 tables)** — Stage-2 Flex Suite (post-launch,
  post-capital, post-legal per S60 lock).

Down from 18 missing at the S85 audit (16 closed across S87→S93,
~2 sessions per 5 tables). The phantom-table chapter is effectively
closed for the launch product. Flex Suite is explicitly stage-2
post-launch.

## Pre-launch blockers still open

- Item 16 batch 2 — bank ACH origination provider selection.
- Item 16 batch 3+ — OTP enablement (FlexPay SetupIntent), pi_* audit.
- Item 10 (S90) payment integration — gated on Item 16 batch 2.

That's it for blockers. Everything else on the board is either
shipped, partial-with-frontend-deferred, or stage-2 post-launch.

## What next session should target

Top picks for S94:

1. **Item 16 batch 2 — bank ACH origination provider.** The single
   biggest pre-launch decision left. You said you wanted to wait on
   picking the rail (Increase / Column / Modern Treasury / Mercury /
   direct bank API / NACHA file upload). If you've narrowed it down
   between sessions, this is the time. Once picked, swap the throw
   in `services/disbursementFiring.ts:fireViaBankAch` for the real
   call, set `DISBURSEMENT_RAIL=bank_ach`, wire the settlement
   webhook handler. ~1 session per provider once selected.
2. **Item 10 utility billing payment integration.** Now that the
   utility_bills table is live (S90), wiring it into the rent
   payment flow can land — either as a line item on the next rent
   ACH or as a separate cycle pull. Decision either way is
   constrained by Item 16 batch 2 (which rail), so this is gated.
3. **Frontend perm-aware nav for the books portal.** S82 wired
   landlord; books portal needs the same now that bookkeeper_scopes
   is the source of truth (S91). Half-day frontend session.
4. **Item 15 — E-sign frontend smoke.** Visual polish + e2e walk
   on top of S29 hardening. UI work, not currently your focus.

Recommend **#1** if you've made the rail call; **#3** if you want to
keep going backend-adjacent without hitting product decisions.
Everything else is gated on #1.
