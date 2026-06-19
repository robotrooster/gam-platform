# SESSION 499 HANDOFF

## Theme
GAM-for-Business portal — shipped the four remaining items from the S497
"open menu" in one pass: **G (POS tips), J (discounts/coupons),
E (work-order time tracking), D (onboarding wizard).** Internal feature
labels continue the S492–S511 sequence as **S512–S515** (not the same as
the SESSION_N chat number).

> Read S497 handoff for the full business-portal architecture (Stripe
> Customer model, polymorphic attachments, requireBusinessAccess gating,
> the BUSINESS_FEATURES / BUSINESS_STAFF_PERMISSIONS catalogs).

## Status snapshot
- **Tests:** 378/378 across the 17 business backend suites
  (`npx vitest run src/routes/business src/middleware/businessAccess.test.ts
  src/services/businessPdf.test.ts`). +20 over S497.
- **Builds:** apps/api tsc clean (filtering the pre-existing
  `ingestLexisAdvance` / `ingestAKRealEstate` / `ingestDERealEstate`
  errors that pre-date this arc). apps/business tsc + `npm run build`
  clean. packages/shared builds clean.
- **Migrations:** all applied. Latest is
  `20260617150000_business_onboarding.sql`.
- **Dev work:** no commits, no pushes — Nic decides when.

## Shipped

### S512 — POS tips (G)
- Migration `20260617120000_business_pos_tips.sql`: `tip_amount` on
  `business_pos_transactions` (default 0, nonneg CHECK).
- **Money model:** `total_amount` stays SALE-ONLY (subtotal + tax); tip
  tracked separately. Grand total charged = `total_amount + tip_amount`,
  computed at charge time (cash change) + receipt render. Keeps every
  existing revenue aggregation meaning "sales", not "sales + tips".
- Route (`businessPos.ts`): `tipAmount` in create schema; cash change
  validates against grand total; tip stored. List query + PDF receipt +
  reports (`total_tips` in the POS section) all carry it.
- Frontend (`POSPage.tsx`): tip presets (15/18/20/custom) in checkout,
  shown on receipt + history detail. Tendered tracks grand total.

### S513 — Discounts / coupons (J)
- New shared catalog: `BUSINESS_DISCOUNT_TYPES` (`percent` | `fixed`),
  new feature `'discounts'` (+ label/description + added to
  mini_market / mechanic_* / maintenance_crew defaults), new staff perms
  `discounts.read` / `discounts.write` (+ group/label + manager/office
  role defaults).
- Migration `20260617130000_business_discounts.sql` (one feature, three
  inseparable parts): feature-CHECK ALTER, `business_discount_codes`
  table, `discount_code_id` + `discount_amount` on
  `business_pos_transactions` + `business_invoices`.
- **Money model:** discount is PRE-TAX on the subtotal
  (percent → subtotal×%/100; fixed → min(value, subtotal)). POS scales
  the accumulated per-line tax by `(subtotal−discount)/subtotal`
  (mathematically identical to a proportional per-line discount, no
  per-line schema churn — lines stay full-price, discount shows as a
  transaction-level line). Invoices recompute order-level tax on the
  discounted subtotal.
- Shared service `services/businessDiscounts.ts`:
  `computeDiscountAmount` / `resolveDiscountCode` (validates active +
  window + redemption cap, optional FOR UPDATE) / `applyDiscount`
  (consumes a redemption under the lock). Used by BOTH the POS sale path
  and invoice-create path (DRY).
- Route `businessDiscounts.ts`: CRUD + `POST /preview` (validate +
  compute, no redemption). Delete refuses a used code (409 → deactivate).
- Frontend: new `DiscountsPage.tsx` (nav item gated by `discounts`,
  owner-only) + apply-code UI in POS checkout and invoice create (both
  gated on the feature), discount line on receipts/detail/PDFs.

### S514 — Work-order time tracking (E)
- Migration `20260617140000_business_work_order_time_entries.sql`:
  `business_work_order_time_entries` (clock-in→out spans). Partial unique
  index = one running clock per (work_order, tech); different techs run
  concurrently. Billing linkage via `billed_at` + `billed_line_id`.
- Route (`businessWorkOrders.ts`) endpoints, all gated `work_orders.write`
  (no new feature — sub-capability of work orders):
  - `POST /:id/time/start` (409 on double-start via the unique index),
    `POST /:id/time/stop` (computes duration in SQL via NOW()),
    `POST /:id/time/manual` (already-stopped span), `DELETE /:id/time/:eid`
    (refuses billed), `POST /:id/time/bill` (rolls all unbilled stopped
    spans into ONE labor line — hours×rate — and recomputes WO totals).
  - WO detail (`GET /:id`) now returns `timeEntries` (+ tech name).
- Frontend (`WorkOrdersPage.tsx`): `TimeSection` on the WO detail —
  clock in/out, entry table with running/unbilled/billed status, and a
  "Bill as labor" → `BillTimeModal` (hourly rate + optional desc/tax).

### S515 — Onboarding wizard (D)
- Migration `20260617150000_business_onboarding.sql`:
  `businesses.onboarding_completed_at` (nullable; NULL = wizard shows).
- Route (`businesses.ts`): `GET /me/onboarding` (derives step status from
  real data — profile/features/stripe/tax/customers + customerCount) +
  `POST /me/onboarding/complete` (idempotent finish/dismiss).
- New genuinely-new capability: `POST /api/business-customers/import`
  (`businessCustomers.ts`) — bulk CSV import. Frontend parses the CSV,
  posts a JSON array; backend validates each row independently, inserts
  valid ones, returns `{created, skipped, total, errors[]}`. Geocode is
  skipped on bulk (backfills via `/:id/geocode` later).
- Frontend: `components/OnboardingWizard.tsx` — dismissible dashboard
  banner → stepped modal (address / features / Stripe / tax / CSV import).
  Each step writes through to its real endpoint; the checklist
  self-updates from data. Stripe step deep-links to Settings. Mounted on
  `DashboardPage`. Self-hides once `onboarding_completed_at` is set.

## Decisions made
- POS tips: `total_amount` stays sale-only; tips tracked apart (honors
  S497's "tracked separately"). Tips are NOT folded into revenue
  aggregations; a separate `total_tips` shows in Reports.
- Discounts apply PRE-TAX; POS uses the tax-scaling trick instead of
  rewriting line rows. Used codes can't be deleted (deactivate instead) —
  preserves sale history (capture-everything mandate).
- Time tracking is a `work_orders` sub-capability (no new feature
  toggle). Tracked time → a single rolled-up labor line on bill.
- Onboarding steps are DERIVED from data (no per-step booleans stored);
  only the completion/dismiss timestamp persists.

## Files touched (salient)
- **Shared:** `packages/shared/src/index.ts` — `BUSINESS_DISCOUNT_TYPES`,
  `discounts` feature, `discounts.read/write` perms + role defaults.
- **Migrations:** the four `20260617*` files above.
- **Backend new:** `services/businessDiscounts.ts`,
  `routes/businessDiscounts.ts`.
- **Backend edited:** `routes/businessPos.ts`, `routes/businessInvoices.ts`,
  `routes/businessWorkOrders.ts`, `routes/businessCustomers.ts`,
  `routes/businesses.ts`, `routes/businessReports.ts`,
  `services/businessPdf.ts`, `index.ts` (router registration).
- **Frontend new:** `apps/business/src/pages/DiscountsPage.tsx`,
  `apps/business/src/components/OnboardingWizard.tsx`.
- **Frontend edited:** `POSPage.tsx`, `InvoicesPage.tsx`,
  `WorkOrdersPage.tsx`, `DashboardPage.tsx`,
  `components/layout/Layout.tsx`, `main.tsx`.
- **Tests:** new `businessDiscounts.test.ts`; cases added to
  `businessPos` / `businessInvoices` / `businessWorkOrders` /
  `businesses` / `businessCustomers` tests (+ the mini_market default-
  features assertion updated for `discounts`).

## Open menu (next session pick)
From the S497 menu, all of D/E/G/J are now shipped. Remaining gaps that
surfaced but were never built:
- Stripe Connect embedded **payouts/dashboard** view for the owner
  (only KYC is embedded today).
- **PO / vendor restocking** workflow for inventory low-stock.
- **Multi-location** support.
- **CSV export** on Reports; AR-aging trend over time.
- Recurring-schedule "skip a cycle".
- Discounts polish: per-line (vs order-level) discounts; discount usage
  on the Reports page; surface discount on quotes (currently POS +
  invoices only).
- Wire the customer CSV import into the CustomersPage too (today it lives
  only in the onboarding wizard).

## Notes
- No smoke walks proposed; Nic walks when the visible code backlog is
  clear. No commits proposed.
- The S498 agent-revenue-permissions arc (different theme) is untouched
  this session; its deferred items still stand in SESSION_498_HANDOFF.
