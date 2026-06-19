# SESSION 500 HANDOFF

## Theme
GAM-for-Business "ready for real use" pass. Two batches in one chat:
**(A)** the four S497 open-menu items — POS tips, discounts, WO time
tracking, onboarding wizard (internal S512–S515; documented in
SESSION_499_HANDOFF). **(B)** a gap analysis of what a real operator
still needs, then built the top four: **money visibility/payouts, sales-
tax report, automated appointment reminders, refund robustness**
(internal S516–S519).

> This handoff covers batch B (S516–S519). Batch A is in
> SESSION_499_HANDOFF. Read S497 for the base business-portal
> architecture.

## Status snapshot
- **Tests:** 403/403 across 19 business backend suites
  (`npx vitest run src/routes/business src/middleware/businessAccess.test.ts
  src/services/businessPdf.test.ts src/services/appointmentReminders.test.ts`).
  +25 over the 378 at the start of batch B.
- **Builds:** apps/api tsc clean (filtering the pre-existing
  `ingest*` errors unrelated to this arc). apps/business tsc +
  `npm run build` clean. packages/shared clean.
- **Migrations:** all applied. This session added six `20260617*`
  files; latest is `20260617170000_business_refunds.sql`.
- **Dev work:** no commits, no pushes — Nic decides when.

## Shipped (batch B)

### S516 — Money visibility / payouts
- Reused the existing `services/connectPayouts.ts` (getConnectBalance /
  getAvailableUsdBalance / firePayoutForConnectAccount) + the
  webhook-fed `connect_payouts` table — **no schema change**.
- `routes/businesses.ts`: `GET /me/connect/balance` (live Stripe
  available+pending USD), `GET /me/connect/payouts` (history from
  connect_payouts by stripe_account_id — no live call), `POST
  /me/connect/payouts` (manual payout; defaults to entire available
  balance; minute-bucket idempotency key; gated on payouts_enabled).
- Frontend: new `PayoutsPage.tsx` (balance cards + "Pay out now" modal +
  history) on a new `/payouts` route, nav under Insights gated by the
  `payments` feature, owner-only. Shows a "connect in Settings" state
  on the 409 when no Connect account exists.
- Tests: `businessPayouts.test.ts` (8) — Stripe service layer mocked.
  **Gotcha:** mock the service with a static `import` after the
  `vi.mock` calls (hoisted); a top-level `await import()` compiles under
  vitest but fails `tsc --noEmit` (TS1378).

### S517 — Sales-tax-collected report
- `routes/businessReports.ts`: new `sales_tax` section on the overview
  aggregate — tax from completed POS sales + issued (sent/paid)
  invoices, bucketed by month, net of discounts, with a period total.
  Computed when POS or invoicing is on.
- Frontend: new "Sales tax" tab in `ReportsPage.tsx` (total cards +
  by-month table + "GAM does not file on your behalf" note).
- Tests: +2 in `businessReports.test.ts`.

### S518 — Automated appointment reminders
- Migration `20260617160000`: `appointments.reminder_sent_at` (one-shot
  idempotency guard).
- `services/appointmentReminders.ts → sendAppointmentReminders()`:
  finds scheduled appointments entering the next-24h window with a
  customer email + no reminder yet, emails them, stamps
  `reminder_sent_at` only on success (failures retry next run).
- `services/email.ts`: new `emailBusinessAppointmentReminder`.
- Cron: hourly (`'5 * * * *'`, America/Phoenix) in `jobs/scheduler.ts`.
- Backend-only (automated, no UI). Tests:
  `appointmentReminders.test.ts` (7).

### S519 — Refund robustness (POS partial + invoice refunds)
- Migration `20260617170000`:
  - POS: `business_pos_transactions.refunded_amount`,
    `business_pos_transaction_lines.refunded_qty`, new
    `partially_refunded` status, widened refund-consistency CHECK.
  - Invoices: `refunded_amount` / `refunded_at` / `refund_reason`, new
    `partially_refunded` + `refunded` statuses.
- **POS** `POST /:id/refund` reworked to support line-level partial
  refunds (`lines:[{lineId,quantity}]`; omit = refund everything
  remaining). Restores stock per refunded qty, bumps refunded_qty,
  flips to `partially_refunded` until every line is fully returned then
  `refunded`. Refund dollars are **proportional to the actual charged
  total** (`unit_price*qty/subtotal * total_amount`) so a discounted
  sale refunds the discounted amount, not list price.
- **Invoices** `POST /:id/refund` records a refund against a paid
  invoice (full/partial). Bookkeeping only — operator runs the actual
  money refund on Stripe/terminal (same posture as POS card refunds).
- Frontend: POS RefundModal got a "Pick items" mode with per-line qty;
  status badges + detail show partial/refunded + amount. Invoice detail
  got a "Refund" button + `RefundInvoiceModal` (full/amount).
- Tests: +4 POS, +4 invoices.

## Decisions made
- Refunds = bookkeeping + stock/ledger; the operator executes the
  actual money refund on Stripe/terminal. Consistent with existing POS
  card-refund copy. (A future enhancement could fire the live Stripe
  refund for checkout-paid invoices — needs the payment_intent plumbing.)
- Payout history reads the webhook-fed `connect_payouts` table (no live
  Stripe list call); balance + the payout trigger are the only live
  Stripe touches.
- Appointment reminders: 24h window, hourly cron, one-shot. No SMS
  (Nic's standing "no SMS for now").

## Files touched (batch B, salient)
- **Backend:** `routes/businesses.ts` (payout endpoints),
  `routes/businessReports.ts` (tax section), `routes/businessPos.ts`
  (partial refund), `routes/businessInvoices.ts` (invoice refund),
  `services/appointmentReminders.ts` (new), `services/email.ts`
  (reminder helper), `jobs/scheduler.ts` (cron).
- **Frontend:** `pages/PayoutsPage.tsx` (new), `pages/ReportsPage.tsx`
  (tax tab), `pages/POSPage.tsx` (refund UI), `pages/InvoicesPage.tsx`
  (refund UI), `components/layout/Layout.tsx` + `main.tsx` (payouts nav/
  route).
- **Migrations:** `20260617160000_appointment_reminder_sent.sql`,
  `20260617170000_business_refunds.sql`.
- **Tests:** new `businessPayouts.test.ts`,
  `appointmentReminders.test.ts`; cases added to businessReports /
  businessPos / businessInvoices.

## Still open for business use (next-session menu)
Tier-3 / polish from the gap analysis that remain:
- **Live Stripe refund** for checkout-paid invoices (currently
  bookkeeping-only) — needs the charge/payment_intent stored at pay time.
- **Customer self-service portal** (log in to view/pay invoice history)
  — today only per-invoice hosted-pay links + public booking.
- **Expense tracking / P&L** — Reports shows revenue only; S497 punted
  expenses to GAM Books, but Books isn't wired for business customers.
  Needs a cross-portal product call from Nic.
- **Multi-location** support (one business = one set of everything).
- **CSV export** on Reports; AR-aging trend over time.
- Per-business toggle to opt OUT of appointment reminders (currently
  always-on for appointment businesses).
- Wire the customer CSV import (built in S515) into CustomersPage too —
  today it lives only in the onboarding wizard.
- Discounts: per-line discounts; discounts on quotes; discount usage in
  Reports.

## Notes
- No smoke walks proposed; Nic walks when the visible code backlog is
  clear. No commits proposed.
- The S498 agent-revenue-permissions arc is untouched; its deferred
  items still stand in SESSION_498_HANDOFF.
