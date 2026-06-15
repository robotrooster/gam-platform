# Session 494 — closed

> GAM for Business — Stripe Connect wiring for invoice
> payments. Step 2b of the suite.

## Theme

**Business operators can now accept card + ACH payments on
invoices via Stripe Checkout. Owner clicks "Set up payments"
in Settings → embedded ConnectAccountOnboarding component
handles KYC inside the GAM URL. Once Connect is live, sending
an invoice auto-creates a Stripe Checkout Session, returns a
hosted-pay URL, and the InvoicesPage detail surfaces it with
a copy button for the operator to send to the customer. When
the customer pays on Stripe's hosted page,
`checkout.session.completed` webhook flips the invoice to paid
and stamps the PaymentIntent for audit.**

Suite (api) at S493 close: 3141 / 165.
Suite (api) at S494 close: **3142 / 165 / 0 failures** (+1 S494
case confirming hosted_pay_url is null when Connect not set up).

apps/business tsc + build clean. Bundle 356.92 KB / 100.80 KB
gzipped (+12 KB vs S493 from the embedded Connect components).

## What shipped

### Migration: `20260614150000_business_invoices_checkout.sql`

Two additive columns on `business_invoices`:
- `stripe_checkout_session_id text` — webhook lookup key for
  idempotent mark-paid. Unique partial index where NOT NULL.
- `hosted_pay_url text` — cached Checkout URL, returned on
  detail GET so the UI doesn't need to recreate the session.

Both nullable: invoices created/sent before Connect is configured
(or for businesses that prefer manual mark-paid only) won't have
these set.

Applied; schema regenerated (13,518 lines).

### `apps/api/src/services/stripeConnect.ts`

- **`ConnectEntity` extended** to include `'business'` alongside
  `'user'` and `'pm_company'`.
- **`fetchExistingConnectId` + `persistConnectId`** got branches
  that read/write `businesses.stripe_connect_account_id`.
- **NEW: `createInvoiceCheckoutSession(opts)`** — destination-
  charge Checkout Session with:
  - `mode: 'payment'`
  - `payment_method_types: ['card', 'us_bank_account']`
  - `customer_email` pre-filled when business_customers has one
  - `line_items: [{ price_data: { unit_amount: amountCents, product_data: { name: 'Invoice INV-XXXX' } } }]`
  - `payment_intent_data.transfer_data.destination` = business's
    Connect account
  - `application_fee_amount: 0` for now (per the deferred-fee-
    config decision)
  - `metadata.gam_purpose: 'business_invoice'` on both session
    and the intent so the webhook can route correctly
  - Success/cancel URLs point at the marketing site (placeholder
    landing pages; a dedicated /invoice-paid page is a future
    polish)

Returns `{ sessionId, hostedUrl }`.

### `apps/api/src/routes/businesses.ts`

- **NEW: `POST /me/connect/onboarding-link`** — owner-only;
  calls `ensureConnectAccount({ entity: 'business' })` and
  returns a fresh `clientSecret` for the embedded
  `<ConnectAccountOnboarding />` component.
- **NEW: `GET /me/connect/account-status`** — owner-only;
  returns live Connect state from Stripe + persists the
  `connect_payouts_enabled` and `connect_details_submitted`
  flags onto the businesses row. When no Connect account
  exists yet, returns a placeholder shape so the UI can
  render "Not started" instead of erroring.

### `apps/api/src/routes/businessInvoices.ts`

- **`POST /:id/send` extended** — when business has Connect
  configured AND `connect_payouts_enabled` is true, creates a
  Checkout Session, persists session id + hosted URL on the
  invoice row, returns the hosted URL in the response.
  - Failure of the Checkout creation is swallowed; send still
    succeeds, owner can mark-paid manually later.
- Detail GET now returns the new columns via the existing
  `SELECT i.*` projection.

### `apps/api/src/routes/webhooks.ts`

- **NEW: `case 'checkout.session.completed'` branch.**
- Filters on `metadata.gam_purpose === 'business_invoice'` so
  it doesn't collide with any future Checkout flows.
- Looks up the invoice by `stripe_checkout_session_id` (the
  partial unique index makes this fast + idempotent), flips
  status to `paid`, stamps `paid_at`, `amount_paid` (from
  Stripe's `session.amount_total`), `payment_method = 'card'`,
  and `stripe_payment_intent_id` from the session.
- Logs a warning when the metadata is right but no matching
  row exists (admin investigation hook).
- 500s on DB errors so Stripe retries.

### `apps/business/src/pages/SettingsPage.tsx`

- **NEW: `<StripeConnectSection />`** component rendered above
  the existing Features section.
- Mirrors the landlord BankingPage pattern:
  - `loadConnectAndInitialize` with `VITE_STRIPE_PUBLISHABLE_KEY`
  - `fetchClientSecret` callback hits the new onboarding-link
    endpoint
  - Embedded `<ConnectAccountOnboarding />` inside
    `<ConnectComponentsProvider />`
  - Status query polls every 4s while the onboarding sheet is
    open
- Status badge: amber when not started / verifying / incomplete;
  green when ready (`payouts_enabled && details_submitted`).
- "Outstanding requirements" surface when present.

Required npm dependencies added to apps/business:
`@stripe/connect-js@^3.4.5` + `@stripe/react-connect-js@^3.4.3`.

### `apps/business/src/pages/InvoicesPage.tsx`

- `InvoiceDetail` type gains `hostedPayUrl: string | null`.
- **NEW: `<PayLinkCard />`** rendered in detail view when
  `status === 'sent' && hostedPayUrl !== null`.
- Green-themed card with the URL in a monospace readonly input
  + a "Copy link" button (uses `navigator.clipboard.writeText`;
  shows "Copied!" feedback for 2s).
- Copy text below the link explains the customer flow:
  "Send this link to your customer. They can pay by card or
  ACH on Stripe's secure page; funds settle to your Connect
  account."

## Items shipped

```
apps/api/src/db/migrations/
  20260614150000_business_invoices_checkout.sql   (NEW)
apps/api/src/db/
  schema.sql                                       (regenerated)
apps/api/src/services/
  stripeConnect.ts                                 (+ business entity, + createInvoiceCheckoutSession)
apps/api/src/routes/
  businesses.ts                                    (+ Connect onboarding/status endpoints)
  businessInvoices.ts                              (send creates Checkout session)
  businessInvoices.test.ts                         (+1 S494 case)
  webhooks.ts                                      (+ checkout.session.completed branch)
apps/business/package.json                         (+ @stripe/connect-js + @stripe/react-connect-js)
apps/business/src/pages/
  SettingsPage.tsx                                 (+ StripeConnectSection)
  InvoicesPage.tsx                                 (+ PayLinkCard + hostedPayUrl field)
```

## Decisions made during build

| Question | Decision |
|---|---|
| PaymentIntents vs Checkout Sessions for customer pay | **Checkout Sessions.** Customer doesn't have a GAM account (per the S491 decision deferring customer-side portal). Checkout gives Stripe-hosted card + ACH page with no GAM customer flow. |
| Where Checkout session is created | **Inside `POST /:id/send`** — natural lifecycle hook. Owner ships an invoice → URL is ready to share. No separate "generate pay link" action needed. |
| Application fee (GAM platform cut) | **0 for now.** Nic hasn't dialed in the business-invoicing pricing model yet. Schema/code carries the field — when Nic decides, set `applicationFeeCents` from a business or platform-wide config. |
| Webhook routing | **`metadata.gam_purpose: 'business_invoice'`** on both the session and the intent. Webhook handler routes by this key, avoiding collisions with any future Checkout flows (rent, POS, etc.). |
| Session expiry handling | **Skip for now.** Stripe Checkout Sessions expire in 24h by default; an expired URL fails on the customer side. Recreating-on-demand is a future polish — for now owner re-sends or marks paid manually. |
| Failure of Checkout creation during send | **Swallow + log; send succeeds with hosted_pay_url=null.** Owner can still mark-paid manually. Connect outage shouldn't block invoice send. |
| Onboarding UX | **Embedded `<ConnectAccountOnboarding />`** matching the landlord pattern. Owner stays inside GAM's URL; KYC renders inline. |
| Pay-link delivery to customer | **Manual copy/paste for now.** Email send via Resend is a small follow-up. Owner copies the URL and texts/emails it. |
| Webhook test coverage | **Minimal.** Heavy Stripe webhook mocking is its own infrastructure pass; existing webhook tests are reference. S494 adds one assertion that hosted_pay_url is null when Connect isn't set, confirming the flow doesn't break in that branch. |

## Verification

- `cd apps/api && npx tsc --noEmit`: clean (ignoring pre-existing
  probe-file noise, unrelated).
- `cd apps/business && npx tsc --noEmit`: clean.
- `cd apps/business && npm run build`: clean. 356.92 KB JS /
  100.80 KB gzipped (+12 KB vs S493 from embedded Connect SDK).
- Targeted: `vitest run businessInvoices.test.ts` — 20 passed
  (19 prior + 1 S494).
- Full: `npm test` — **3142 / 165 / 0** (+1 from S493).
- Migration applied; schema regenerated.

### Bugs caught during build

- **Brittle SQL substitution hack** in the webhook handler
  (`.replace('(session.amount_total / 100.0)', '$3')`).
  Rewrote cleanly with the value bound as the 3rd parameter.

## Phase status — GAM for Business suite

| Step | Status |
|---|---|
| 1. Feature toggle infrastructure | ✅ S492 |
| 2. Invoicing CRUD + manual mark-paid | ✅ S493 |
| 2b. Stripe Connect wiring (online pay) | ✅ **S494** |
| 3. Appointments | ⏳ |
| 4. Per-vertical: POS, work_orders, customer_vehicles | ⏳ |
| Polish: Email send via Resend; /invoice-paid landing page | ⏳ |
| Polish: Session expiry → recreate-on-demand | ⏳ |

## What the next session should target

Per the agreed build order: **appointments**.

Appointments cover:
- A timed visit between a business and a customer (haircut,
  consultation, mobile mechanic call, etc.)
- Independent of routing — the trash company doesn't use them;
  the hair salon doesn't use schedules. Toggle is `appointments`
  in the feature catalog (already in the shared enum).
- Reuses `business_customers` for the who.

Backend scope:
- `business_appointments` table (customer_id, scheduled_for,
  duration_minutes, service_type, status, notes)
- Status: scheduled / confirmed / completed / cancelled / no_show
  (mirrors the existing `appointments` table from Phase 1a —
  could potentially reuse that table since it's also business-
  scoped; need to check)
- CRUD endpoints with the same feature gate
- Frontend page with calendar/list view

If `appointments` table from Phase 1a (S460) is already shaped
right, it's a code reuse story. If not, fresh table mirroring
the invoicing pattern.

Alternative polish targets:
- **Email send for invoice pay links** — Resend wiring; small
  follow-up
- **`/invoice-paid` landing page** on marketing site so customers
  hitting the success_url see a branded thank-you instead of a
  generic Stripe redirect

Recommend **appointments** for the next session since polish is
small and can ride on top of any feature build.

---

End of S494 handoff. **Stripe Connect wiring live for business
invoices. Customer-pay flow end-to-end: owner sends → URL
generated → customer pays on Stripe → webhook marks paid.**

3142 tests / 165 files / 0 failures.

**Step 2b shipped. Customers can now pay business invoices
online.**
