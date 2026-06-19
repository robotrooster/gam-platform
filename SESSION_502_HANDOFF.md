# SESSION 502 HANDOFF

## Theme
GAM-for-Business feature push: four operator features in sequence —
**live Stripe refunds, customer self-service portal, A/R-aging report +
CSV export, appointment-reminder opt-out**. Plus a regression fix to the
S501 guest-agent work (agentType).

> S501 covered the agent-permissions UI toggle + the booking-guest agent
> track (same chat, earlier arc). This handoff is the business-portal arc.

## Status snapshot
- **Builds:** apps/api tsc clean (pre-existing `ingest*` errors filtered),
  apps/business tsc clean, apps/landlord clean.
- **Tests:** all affected suites green —
  `businessInvoices` 39, `publicCustomerPortal` 7 (new), `businessReports`
  22, `businessCustomers`, `appointmentReminders` (+1), `profiles`/`tools`/
  `agent` (guest-agent fix). No stray vitest processes.
- **Migrations applied** (this arc): `20260618140000_agent_type_booking`,
  `20260618150000_business_invoice_stripe_refund`,
  `20260618160000_business_customer_portal_tokens`,
  `20260618170000_business_appointment_reminders_toggle`.
- No commits, no pushes.

## Regression fix (from S501 guest-agent work)
The S501 `GUEST_ENTRY` profile was `agentType: 'customer_service'`, which
swept the guest agent into `profiles.test`'s "exactly four CS profiles"
group (the one requiring baked-in CS guardrails) → 4 failing tests. Fix:
gave the guest agent its own `agentType: 'booking'` (the value the
codebase already reserved), added `'booking'` to `AGENT_TYPES`, and
migration `20260618140000` widens the `agent_interaction_logs.agent_type`
CHECK. (Separately diagnosed 3 PRE-EXISTING S498 failures in
`agentSession.test`/`logInteraction.test` — uncommitted S498 turn_index +
HUMAN_HANDOFF_REPLY changes; they PASS at HEAD. NOT this session's; left
for the S498 thread. One — curated-FAQ `res.model` undefined — may be a
real S498 bug, not just a stale test.)

## Shipped (business features)

### 1. Live Stripe refunds (invoices)
- `services/stripeConnect.ts → refundBusinessInvoicePayment` —
  `stripe.refunds.create({ payment_intent, reverse_transfer: true, amount? })`.
  `reverse_transfer` pulls the refund from the business's Connect balance
  (destination charge), never GAM's. **`refund_application_fee` omitted —
  Nic's call: GAM keeps its platform fee; the business bears it on the
  refunded amount.**
- `routes/businessInvoices.ts` refund route: fires the live refund when
  `stripe_payment_intent_id` is set (Stripe-paid), BEFORE the bookkeeping
  write — Stripe rejection → 502, nothing recorded. No payment_intent
  (cash/terminal/manual) → unchanged bookkeeping-only path. Full refund
  omits amount (exact remainder); idempotency key on cumulative total.
- Migration `…150000`: `business_invoices.stripe_refund_id`.
- POS refunds stay terminal/bookkeeping (POS txns store no payment_intent).
- Frontend: `InvoicesPage` refund-modal copy updated (auto vs bookkeeping),
  button `Record refund` → `Refund`.

### 2. Customer self-service portal
- A no-login business customer gets a reusable link to see invoice history
  + balance and pay open invoices.
- Migration `…160000`: `business_customer_portal_tokens` (reusable,
  180-day, revocable). `services/customerPortalTokens.ts`
  (getOrCreate reuses a live token / resolve fails closed).
- `routes/publicCustomerPortal.ts` (mounted `/api/public`):
  `GET /customer/:token` (history + balance, draft/void hidden,
  per-invoice payable + amountDue, outstanding total),
  `POST /customer/:token/invoices/:id/pay` (returns/mints the hosted-pay
  link; 409 non-open; 404 cross-customer).
- Issuance: `POST /api/business-customers/:id/portal-link` (get-or-create,
  optional email) + `emailBusinessCustomerPortalLink`.
- Marketing site (`apps/marketing/server.js`): new `/account/:token` shell
  (same vanilla pattern as `/book/:slug`, `/update-payment/:token`).
- Business portal: "Account link" button on `CustomersPage`.

### 3. A/R-aging report + CSV export
- `routes/businessReports.ts`: new `ar_aging` section on `/overview`
  (invoicing on). Point-in-time (ignores range): every `sent` invoice with
  a remaining balance, bucketed current / 1–30 / 31–60 / 61–90 / 90+, with
  per-customer breakdown + totals. Unpaid-remainder only; draft/paid/void
  excluded. **Bucket keys are underscore-free** (`d1to30`…) so the client
  snake→camel transform is a no-op.
- `ReportsPage.tsx`: "A/R aging" tab (bucket stat cards, per-customer table
  w/ 90+ in red) + **Export CSV** (vanilla Blob, no dep).

### 4. Appointment-reminder opt-out
- Migration `…170000`: `businesses.appointment_reminders_enabled` (default
  true). `services/appointmentReminders.ts` SELECT now requires it TRUE.
- `routes/businesses.ts` PATCH /me: `appointmentRemindersEnabled` field +
  UPDATE + both return SELECTs.
- `SettingsPage.tsx`: "Appointment reminders" toggle section, gated on the
  `appointments` feature.

## Decisions made (Nic)
- Refund fee policy: GAM keeps its platform fee (`refund_application_fee`
  omitted; `reverse_transfer` still on).
- Customer portal: tokened no-login surface on the marketing site.
- Guest agent is its own `agentType` ('booking'), not customer_service.

## Files touched (salient)
- Backend: `services/{stripeConnect,customerPortalTokens,appointmentReminders}.ts`,
  `services/email.ts`, `routes/{businessInvoices,publicCustomerPortal,
  businessCustomers,businessReports,businesses}.ts`,
  `services/agents/{types,profiles}.ts`, `index.ts`.
- Frontend: `apps/business/src/pages/{InvoicesPage,CustomersPage,
  ReportsPage,SettingsPage}.tsx`, `apps/marketing/server.js`.
- Migrations: the four `20260618{14,15,16,17}0000_*` above.
- Tests: `publicCustomerPortal.test.ts` (new), cases added to
  businessInvoices / businessReports / appointmentReminders; profiles/tools/
  agent guest-agent fixes.

## Still open (business backlog)
- Wire the S515 customer CSV import into `CustomersPage` (today only in the
  onboarding wizard).
- Per-line discounts; discounts on quotes; discount usage in Reports.
- Multi-location support.
- Expenses / P&L — needs a cross-portal product call (GAM Books not wired
  for business customers).
- Token-revoke UI for the customer portal (revoked_at honored; no button).

## Notes
- Watch for stray `DB_NAME=gam_test npx vitest run` processes — one was
  found mid-session corrupting gam_test (non-deterministic 500s in isolated
  runs). `pgrep -fl vitest`; kill before re-testing. (CLAUDE.md zombie note.)
- No smoke walk proposed. No commit proposed.
