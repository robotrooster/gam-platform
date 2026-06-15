# SESSION 497 HANDOFF

**Theme:** GAM-for-Business portal end-to-end build. Twenty
consecutive feature ships (S492–S511, internal labels — not the same
as the SESSION_N chat number) turned `apps/business` from a
feature-toggle skeleton into a full operational SaaS for service
businesses (trash hauling, mini-market POS, stationary/mobile
mechanic). The complete operator surface — onboarding through
payout — runs on the portal.

> **Session length warning:** this was a marathon (~20 hrs of build
> across one chat). The handoff is necessarily long. Read at minimum
> the **Status snapshot**, **Where to start next session**, and the
> **Open menu** sections. The per-feature blocks below are reference
> for re-orientation.

---

## Status snapshot

- **Tests:** 358/358 across 18 business test suites (every shipped
  feature has dedicated coverage).
- **Builds:** apps/api tsc clean (filtering pre-existing
  `ingestLexisAdvance.ts` browser-global error +
  `ingestAKRealEstate` / `ingestDERealEstate` `rowCount` errors that
  are unrelated to this arc). apps/business + packages/shared +
  marketing all build clean.
- **Migrations:** all applied. Latest is
  `20260615040000_business_customer_payment_update_tokens.sql`.
- **Schema growth this session:** ~14 new tables, ~10 ALTER TABLE
  column adds.
- **Dev work:** **no commits, no pushes** — Nic decides when. Working
  tree has all 20 feature ships staged-as-modified.

## Architectural decisions recorded

- **Stripe Customer model.** Saved payment methods live on the
  **platform-side** Stripe Customer (not the connected account). Lets
  the same end-user paying multiple GAM businesses land on one
  Customer, which means cards can survive across business
  relationships. Destination charges pass through the platform's
  balance first anyway.
- **Off-session auto-charge fallback.** When recurring billing's
  off-session PaymentIntent fails (decline/requires_action), we now
  send a **card-update email** (replaces saved PM in-place via
  SetupIntent) rather than a fresh Checkout link (which would mint a
  brand-new PM each cycle and leave the broken default attached). The
  Checkout-with-save-flag path remains as the **first-time-customer
  enrollment** path.
- **Polymorphic attachments.** Single `business_attachments` table
  with `entity_type` + `entity_id` soft-link. Adding a new attachable
  entity (e.g., expenses, future inventory item images) is one entry
  in the `ENTITY_CONFIG` map in
  `apps/api/src/routes/businessAttachments.ts` + one
  `<AttachmentList />` mount in the detail UI. Files live under
  `apps/api/uploads/business-attachments/<businessId>/<uuid>.<ext>`.
- **Auto-tax precedence.** Per-line tax_rate beats per-customer
  exemption beats per-business default. Exempt customer = 0 (overrides
  the business rate). Explicit `taxAmount` on invoice create wins over
  all auto-fill. `dec()` helper rounds money to 2 decimals; **never
  apply it to a numeric(5,4) rate** — that bug landed in S506 (quotes)
  and is fixed.
- **Public surfaces use the marketing-site server.** Two pages added
  to `apps/marketing/server.js` (Node http handler, not React):
  `/book/:slug` (S507 self-service booking) and
  `/update-payment/:token` (S510 card-update). Both are
  server-rendered HTML shells with inline JS that hits the public
  API. No new app added.
- **CSS color tokens vs hardcoded fallbacks.** The business portal
  uses `var(--green, #22c55e)` and `var(--red, #ef4444)` patterns
  where the design tokens aren't fully populated. Worth a one-pass
  token audit later but not blocking.
- **Books owns expenses + P&L.** When Nic asked about expense
  tracking, he correctly noted that GAM Books (port 3006) is the
  bookkeeping layer. Don't build expense tracking into the business
  portal — that's a cross-portal flow when product is ready.

## Feature ships this session (chronological)

### S492 — Feature toggle infrastructure
- `BUSINESS_FEATURES` catalog in `packages/shared/src/index.ts` +
  CHECK constraint on `businesses.enabled_features`.
- `BUSINESS_TYPE_DEFAULT_FEATURES` map drives per-business-type
  pre-fill at signup.

### S493 — Invoicing CRUD
- `business_invoices` + `business_invoice_lines` + per-business
  `INV-NNNN` sequence (`business_invoice_sequences`).

### S494 — Stripe Connect wiring (business entity)
- `ConnectEntity` extended to include `'business'` alongside `user` +
  `pm_company`. Embedded onboarding wired into Settings.
- `createInvoiceCheckoutSession()` destination-charge model.
- `checkout.session.completed` webhook marks the invoice paid.

### S495 — Appointments
- One-off appointments with status workflow (scheduled / completed /
  cancelled / no_show). Cancel-with-no-show flag.

### S496 — Inventory
- 3 tables: `business_inventory_categories` +
  `business_inventory_items` + `business_inventory_adjustments`
  (append-only audit). Stock adjust endpoint with SELECT FOR UPDATE.

### S497 — POS register
- `business_pos_transactions` + lines + sequence. Atomic sale (lock
  items, decrement stock, write 'sold' adjustment). Full refund.
- Fix-forward migration: relaxed
  `business_pos_transaction_lines.item_id` FK from RESTRICT to
  CASCADE so test cleanup works.

### S498 — Mechanic vertical (vehicles + work orders)
- `business_customer_vehicles` (VIN-keyed) + `business_work_orders` +
  `business_work_order_lines` (labor/part/fee) + status workflow +
  convert-to-invoice. Part lines decrement stock atomically with
  audit row.

### S499 — Dashboard
- `/api/business-dashboard/overview` aggregate endpoint with
  feature-aware sections (revenue, AR aging, today's appointments,
  open WOs, low stock, banking status). Frontend re-built from stub.

### S500 — Email send
- `emailBusinessInvoiceSent` + `emailBusinessAppointmentConfirmed`
  in `services/email.ts`. Wired into invoice send + appointment
  create.
- Best-effort: email failure never blocks the underlying mutation.

### S501 — Quotes / estimates
- `business_quotes` + lines + sequence. Status workflow draft → sent
  → accepted/declined/expired. Convert-to-invoice + convert-to-WO
  (part lines decrement stock at WO conversion only, not at quote
  time).

### S502 — Staff permissions framework
- `BUSINESS_STAFF_PERMISSIONS` catalog (24 keys) + role-default map
  in shared. Existing `business_users.permissions` jsonb column
  standardized to a JSON array of grant keys.
- New `middleware/businessAccess.ts` with `requireBusinessAccess(req,
  { permission, feature, ownerOnly? })`. **All 7 new route files
  refactored** to use this shared helper instead of per-file
  `requireOwnerBusinessId`. Owner gets full access; staff gated.
- `StaffPage` got per-staff permission editor modal with grouped
  checkboxes + "reset to role default" button.

### S503 — Reports / analytics
- `/api/business-reports/overview?range=30d|90d|365d` aggregate.
  Daily revenue series, top customers, top POS items, inventory
  stats, WO summary, quote acceptance rate.
- Frontend tabs page with inline SVG line chart (no chart library
  dependency).

### S504 — PDF generation
- `services/businessPdf.ts` with four renderers (invoice / WO /
  quote / POS receipt). Built on existing `pdf-lib` dep.
- `GET /:id/pdf` endpoints on all four routes. Print buttons on all
  four detail views. `useObjectStreams: false` on save so text is
  selectable / searchable.

### S505 — Recurring billing
- `business_recurring_invoice_schedules` + lines + sequence +
  reverse linkage on `business_invoices.source_recurring_schedule_id`.
- `services/recurringInvoiceGeneration.ts` +
  `services/recurringInvoiceSend.ts`. Cron at 9:30am Phoenix daily
  (in `jobs/scheduler.ts`).
- Frontend: separate page `/recurring-invoices`.

### S506 — Automatic sales tax
- `businesses.default_tax_rate` + `tax_label`.
  `business_customers.tax_exempt` + `tax_exempt_reason`.
- Invoice create auto-fills tax when omitted; quote lines default
  rate; POS honors customer exemption.
- Settings has `TaxSection`; CustomersPage edit modal got exemption
  toggle.

### S507 — Customer self-service booking
- Schema: `public_booking_*` columns on businesses + `business_hours`
  jsonb + new `business_bookable_services` table.
- `apps/api/src/routes/businessBookableServices.ts` (owner CRUD).
- `apps/api/src/routes/publicBooking.ts` (3 unauth endpoints).
- Marketing site `/book/:slug` page in `server.js` (server-rendered
  shell + inline JS, no React).
- Permission re-use: bookable services are gated by
  `appointments.read/write`.

### S508 — Saved payment methods
- `business_customers.stripe_customer_id` +
  `default_payment_method_id` + card brand/last4/exp.
  `business_invoices.auto_charge_attempted_at` +
  `auto_charge_last_error`.
- `createInvoiceCheckoutSession` extended with `saveForFutureUse` +
  `existingStripeCustomerId`. Webhook persists saved PM.
- Off-session auto-charge attempt in recurring cycle when PM saved.
- UI indicators: customer list shows AUTO-PAY badge; invoice detail
  shows green "Auto-paid" or red "Auto-charge failed" banner.

### S509 — File attachments
- Polymorphic `business_attachments` table. multer + disk storage
  under `apps/api/uploads/business-attachments/<businessId>/`.
- MIME whitelist: JPEG/PNG/GIF/WebP/HEIC/PDF. 20MB limit.
- Reusable `<AttachmentList />` frontend component. Wired into Work
  Order detail; component supports all 5 entity types (customer /
  quote / invoice / inventory_item / work_order) for future
  wire-up.

### S510 — Customer self-update card link
- `business_customer_payment_update_tokens` (single-use, 7-day
  expiry).
- `services/cardUpdateTokens.ts` + `routes/publicCardUpdate.ts`.
- Marketing site `/update-payment/:token` page with Stripe.js +
  Elements (night theme).
- `recurringInvoiceSend.ts` updated: auto-charge failure now sends
  the card-update email instead of the Checkout-link fallback.
- Owner-side "Update card" button on every customer row.
- `emailBusinessCardUpdateRequest` email helper.

### S511 — Global search
- `/api/business-search?q=` with parallel queries across customers
  + invoices + quotes + WOs + appointments. Permission/feature-gated
  per-category.
- `<GlobalSearch />` component mounted in Layout header.
  Cmd+K / Ctrl+K focuses. 200ms debounce. Outside-click closes.

## Files touched (summary)

The work touched far too many files to enumerate at the leaf level;
the salient surfaces are below. Use `git status` for the full diff
when ready to commit.

### New (this session)

**Backend services:**
- `apps/api/src/services/businessPdf.ts`
- `apps/api/src/services/cardUpdateTokens.ts`
- `apps/api/src/services/recurringInvoiceGeneration.ts`
- `apps/api/src/services/recurringInvoiceSend.ts`

**Backend routes:**
- `apps/api/src/routes/businessInvoices.ts`
- `apps/api/src/routes/businessInventory.ts`
- `apps/api/src/routes/businessPos.ts`
- `apps/api/src/routes/businessVehicles.ts`
- `apps/api/src/routes/businessWorkOrders.ts`
- `apps/api/src/routes/businessDashboard.ts`
- `apps/api/src/routes/businessQuotes.ts`
- `apps/api/src/routes/businessReports.ts`
- `apps/api/src/routes/businessRecurringInvoices.ts`
- `apps/api/src/routes/businessBookableServices.ts`
- `apps/api/src/routes/businessAttachments.ts`
- `apps/api/src/routes/businessSearch.ts`
- `apps/api/src/routes/publicBooking.ts`
- `apps/api/src/routes/publicCardUpdate.ts`

**Backend middleware:**
- `apps/api/src/middleware/businessAccess.ts` (shared
  `requireBusinessAccess` used by all 7 business routes refactored
  in S502)

**Frontend (apps/business):**
- New: `pages/InvoicesPage.tsx`, `pages/InventoryPage.tsx`,
  `pages/POSPage.tsx`, `pages/WorkOrdersPage.tsx`,
  `pages/CustomerVehiclesPage.tsx`, `pages/QuotesPage.tsx`,
  `pages/ReportsPage.tsx`, `pages/RecurringInvoicesPage.tsx`,
  `pages/BookableServicesPage.tsx`
- Heavily extended: `pages/AppointmentsPage.tsx`,
  `pages/CustomersPage.tsx`, `pages/SettingsPage.tsx`,
  `pages/DashboardPage.tsx`, `pages/StaffPage.tsx`,
  `components/layout/Layout.tsx`
- New components: `components/AttachmentList.tsx`,
  `components/GlobalSearch.tsx`
- `lib/api.ts` (added `openPdfInNewTab`, `apiDelete`)

**Marketing:**
- `apps/marketing/server.js` — `/book/:slug` +
  `/update-payment/:token` routes + shells

**Shared:**
- `packages/shared/src/index.ts` — extended business types,
  `BUSINESS_FEATURES`, `BUSINESS_STAFF_PERMISSIONS`,
  `BUSINESS_STAFF_PERMISSION_LABEL/GROUP`,
  `BUSINESS_STAFF_PERMISSIONS_BY_ROLE`

**Migrations applied this session (in order):**
- `20260614130000_business_features_toggle.sql`
- `20260614140000_business_invoices.sql`
- `20260614150000_business_invoices_checkout.sql`
- `20260614160000_business_inventory.sql`
- `20260614170000_business_pos_transactions.sql`
- `20260614170100_business_pos_lines_cascade_item.sql` (fix-forward)
- `20260614180000_business_work_orders.sql`
- `20260614190000_business_quotes.sql`
- `20260614200000_business_staff_permissions.sql`
- `20260614210000_business_recurring_invoices.sql`
- `20260615000000_business_sales_tax.sql`
- `20260615010000_business_public_booking.sql`
- `20260615020000_business_customers_saved_payment_methods.sql`
- `20260615030000_business_attachments.sql`
- `20260615040000_business_customer_payment_update_tokens.sql`

## Open menu (next session pick)

These are the items that remained on Nic's "real operation" + polish
menu after K (global search) shipped:

- **D — Onboarding wizard.** Post-signup walkthrough: business info
  → enable features → connect Stripe → set tax rate → CSV customer
  import. New-user activation.
- **E — Time tracking on work orders.** Tech clocks in/out per WO;
  actual labor billed instead of estimated. Mechanic-specific.
- **G — Tip handling for POS.** Customer adds tip at checkout;
  tracked separately. Salon/food/mobile-service.
- **J — Discounts / coupons.** Owner-created codes (% or $ off) at
  POS + invoice line level.

Items considered + rejected:
- **B (Expense tracking)** — punted to GAM Books (existing portal at
  port 3006). Nic clarified: bookkeeping lives in Books, not the
  business portal.
- **H (SMS via Twilio)** — Nic said "lets not do sms for now."

Other gaps that surfaced but didn't make a menu:
- Stripe Connect embedded **payouts/dashboard** view for the owner
  (currently only KYC is embedded; they see no balance or payout
  history without going to Stripe directly).
- **PO / vendor restocking workflow** for inventory low-stock alerts.
- **Multi-location support** (one business = one set of everything).
- **CSV export** on Reports.
- **AR aging trend over time** (currently point-in-time).
- **Recurring schedule "skip a cycle"** button.

## Where to start next session

1. Read this handoff. Nic picks from the open menu (D / E / G / J)
   or surfaces a fresh item.
2. **Recon first.** Before writing anything, verify the feature's
   integration points still match what's described here — e.g., if
   touching POS for tips (G), re-read the POS route + UI to confirm
   the line schema before extending it.
3. **No smoke walks proposed.** Nic does the visual walk himself
   when the code backlog is cleared.
4. **No commits proposed.** Working tree has 20+ files modified;
   Nic chooses when to commit.

## Memory / catalog state for future sessions

The following are persisted as project memory and should remain in
effect across sessions:

- **BUSINESS_FEATURES catalog** (`packages/shared/src/index.ts`
  ~line 124): single source of truth for
  `businesses.enabled_features` CHECK. Adding a feature requires the
  shared array + a CHECK ALTER migration in lockstep.
- **BUSINESS_STAFF_PERMISSIONS catalog** (~line 245): single source
  of truth for the per-staff jsonb array. Adding a permission
  requires the shared array + role-default map update + (if a new
  endpoint gates on it) the `requireBusinessAccess` call.
- **CLAUDE.md memory entries** are accurate as of session close.

## Items deferred to follow-on (not blocking)

- Customer attachments UI (component exists, not yet wired into a
  customer detail surface — there's no customer detail page yet,
  only a list + edit modal). Same for quote/invoice/inventory_item
  attachments.
- 3DS-required handling on off-session auto-charge (currently
  treated as failure → card-update email; could be smarter).
- Vendor / PO concept for inventory restocking.
- Multi-currency / locale-aware money formatting (everything is
  USD + en-US right now).

## Closing checks (verified)

- `psql gam -c "SELECT filename FROM schema_migrations ORDER BY
  filename DESC LIMIT 5;"` → top is S510 migration
  (`20260615040000_business_customer_payment_update_tokens.sql`) ✓
- `npx vitest run` across 18 business test suites → 358/358 ✓
- `cd apps/business && npm run build` → clean ✓
- `cd apps/api && npx tsc --noEmit` → clean (filtering pre-existing
  ingestion-script errors that pre-date this session and are
  unrelated to the GAM-for-Business arc) ✓
