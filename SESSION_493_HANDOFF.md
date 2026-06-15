# Session 493 — closed

> GAM for Business — invoicing (step 2 of the suite). Backend +
> portal page + manual mark-paid. Stripe Connect wiring lands
> next session.

## Theme

**First feature wired onto the S492 feature-toggle infrastructure.
Every business with `invoicing` enabled can now create invoices,
send them, mark them paid (cash/check/ACH/external), and void
them. Per-business monotonic invoice numbering (INV-0001, INV-0002,
…) tracked via a `business_invoice_sequences` table. Free-form
line items per invoice. Status lifecycle: draft → sent → paid (or
void from any non-paid state). Full CRUD + lifecycle endpoints +
list/detail/create UI in the business portal. Stripe-initiated
payment is deferred to S494 — the schema carries
stripe_payment_intent_id and payment_method ready for wiring.**

Suite (api) at S492 close: 3122 / 164.
Suite (api) at S493 close: **3141 / 165 / 0 failures** (+19
S493 cases + 1 new test file).

apps/business tsc clean. apps/business build: clean (344.53 KB
JS / 96.26 KB gzipped — +18.6 KB vs S492 from the InvoicesPage
+ helpers).

## What shipped

### Migration: `20260614140000_business_invoices.sql`

Three new tables:

**`business_invoice_sequences`** — per-business monotonic invoice
counter. `business_id` PK + `next_number` int. Read+bump in one
UPSERT during create.

**`business_invoices`** — invoice header.
- Core: `business_id`, `customer_id`, `invoice_number` (unique per
  business), `status` ('draft' | 'sent' | 'paid' | 'void'),
  `issue_date`, `due_date`.
- Money: `subtotal`, `tax_amount`, `total_amount`, `amount_paid`
  (all numeric(12,2) NOT NULL DEFAULT 0).
- Lifecycle stamps: `sent_at`, `paid_at`, `voided_at`,
  `void_reason`.
- Payment metadata: `payment_method`,
  `stripe_payment_intent_id`.
- Free-form: `notes` (customer-visible), `internal_notes`
  (business-only).
- Audit invariants enforced by CHECK: sent/paid status requires
  `sent_at`; paid requires `paid_at`; void requires `voided_at`.
- Indexes: business+created_at (list), customer+created_at
  (per-customer view), partial index on status WHERE IN
  ('sent', 'draft') (open-invoice queries).
- ON DELETE CASCADE from `businesses`.

**`business_invoice_lines`** — line items.
- `invoice_id` FK + ON DELETE CASCADE.
- `sort_order` (display position), `description`, `quantity`,
  `unit_price`, `line_total`, `service_key` (future product/SKU
  ref, free-form for now).
- CHECK: quantity > 0; unit_price + line_total >= 0.

Applied; schema.sql regenerated (13,509 lines).

### `apps/api/src/routes/businessInvoices.ts` — NEW

Six endpoints mounted at `/api/business-invoices`:

```
POST   /                      — create (with lines, in one transaction)
GET    /                      — list (status / customer filters)
GET    /:id                   — full detail with lines
POST   /:id/send              — draft → sent
POST   /:id/mark-paid         — sent (or draft) → paid (manual payment)
POST   /:id/void              — non-paid → void with reason
```

All gated by:
- Owner role required (`req.user.role === 'business_owner'`).
- `invoicing` feature enabled on the business (defense-in-depth —
  UI shouldn't expose the surface but a direct API call gets a
  clear 403).
- Per-business scope on every WHERE.

Create transaction:
1. Verify customer belongs to this business.
2. UPSERT the sequence row (`+1`) and grab `next_number - 1` for
   this invoice's number.
3. INSERT the invoice with computed subtotal (sum of
   quantity × unit_price) + tax + total.
4. INSERT each line in sort_order.
5. COMMIT or ROLLBACK.

Manual mark-paid defaults `amount` to the invoice total and
auto-stamps `sent_at` if the invoice was still in draft (a
business may collect cash from a customer they haven't formally
sent yet — common at trade counters).

### `apps/business/src/components/layout/Layout.tsx`

New nav item:
```ts
{ to: '/invoices', icon: Receipt, label: 'Invoices',
  roles: ['business_owner'], feature: 'invoicing' }
```

Sits under Operations, gated by the `invoicing` feature toggle.

### `apps/business/src/pages/InvoicesPage.tsx` — NEW

Full page implementation (~720 lines):
- **List view**: status filter pills (all / draft / sent / paid /
  void), table with invoice number (monospace), customer,
  dates, total, status badge with color tone per status.
- **Empty state** when no customers yet ("Add a customer first").
- **Create modal**: customer dropdown + dates + line items with
  add/remove, live subtotal/tax/total preview, customer notes.
  Submits as draft.
- **Detail view**: invoice header (number, customer, status),
  3-field grid (issued, due, total), notes block, line-item
  table with right-aligned monospace prices, subtotal/tax/total
  summary, status-specific footer banner (paid timestamp +
  method; void timestamp + reason).
- **Action buttons** by status:
  - Draft: Send / Mark paid / Void
  - Sent: Mark paid / Void
  - Paid: read-only
  - Void: read-only
- **Mark-paid modal**: payment method dropdown + amount field
  (defaults to total).
- **Void modal**: required reason textarea.

### `apps/business/src/main.tsx`

`<Route path="/invoices" element={<InvoicesPage />} />` registered.

### `apps/api/src/routes/businessInvoices.test.ts` — NEW

19 cases:
- **Create**: happy + sequential numbering; feature-gate 403;
  cross-business 404; due-before-issue 400; zero lines 400; tax
  adds to total.
- **List**: newest-first with customer join; status filter;
  cross-business isolation.
- **Send**: draft → sent with stamp; second send → 404.
- **Mark-paid**: sent → paid with method/amount; draft auto-stamps
  sent; void → 409.
- **Void**: draft → void with reason; paid → 404; reason required → 400.
- **Detail**: customer email + lines in sort order; cross-business → 404.

## Items shipped

```
apps/api/src/db/migrations/
  20260614140000_business_invoices.sql         (NEW)
apps/api/src/db/
  schema.sql                                   (regenerated, 13,509 lines)
apps/api/src/routes/
  businessInvoices.ts                          (NEW — ~285 lines)
  businessInvoices.test.ts                     (NEW — 19 cases)
apps/api/src/
  index.ts                                     (+ mount)
apps/business/src/pages/
  InvoicesPage.tsx                             (NEW — ~720 lines)
apps/business/src/components/layout/
  Layout.tsx                                   (+ Receipt icon + nav item)
apps/business/src/
  main.tsx                                     (+ route)
```

## Decisions made during build

| Question | Decision |
|---|---|
| Reuse real-estate `invoices` table or new | **New `business_invoices`.** Real-estate is lease-coupled (rent/utilities/deposits/late-fees subtotals); business invoices need free-form line items. Different domain, different schema. Matches the S487 separate-tables posture. |
| Invoice numbering scheme | **Per-business monotonic INV-0001.** Each business gets independent counter; no cross-business collision. Backed by `business_invoice_sequences` table with read+bump in a single UPSERT inside the create transaction. |
| Mark-paid default amount | **Full invoice total.** 95% of the time it's a single full payment. UI default + API fallback both pre-fill total; user can override. |
| Mark-paid on a draft auto-stamps sent_at | **Yes.** Counter-cash transactions don't formally "send" first; landlord swipes a card or takes cash and we record both events at once. |
| Void requires reason | **Yes.** Audit trail. The reason persists on the void_reason column; visible on the detail view. |
| Status lifecycle: simple 4-state or more nuanced | **Simple 4-state** (draft / sent / paid / void). Overdue is derivable from due_date + status='sent'; no separate enum needed. Partial-payment is amount_paid < total — also derivable. |
| Tax handling | **Single tax_amount field for now.** Per-line tax rates are over-engineering for v1; small businesses generally charge a flat tax or none. Per-line tax → future migration if asked. |
| Feature gate enforcement: UI-only or also API | **Both.** UI hides the nav item when feature off; API returns 403 with hint. Defense-in-depth. |
| Stripe Connect wiring | **Defer to S494.** Schema carries the columns; manual mark-paid covers cash/check/external payments today. The wiring is meaningful scope on its own (Stripe destination charges + webhook + onboarding link). |

## Verification

- `cd apps/api && npx tsc --noEmit`: clean.
- `cd apps/business && npx tsc --noEmit`: clean (one unused-import
  caught + removed).
- Targeted: `vitest run businessInvoices.test.ts` — 19 passed.
- Full: `npm test` — **3141 / 165 / 0 failures** (+19 cases + 1
  file).
- `cd apps/business && npm run build`: clean — 344.53 KB JS /
  96.26 KB gzipped (+18.6 KB).
- Migration applied; schema regenerated.

### Bugs caught during build

- **Unused import** `FileText` in InvoicesPage — removed.

## Phase status — GAM for Business suite

| Step | Status |
|---|---|
| 1. Feature toggle infrastructure | ✅ S492 |
| 2. Invoicing + payment collection (backend + manual) | ✅ S493 |
| 2b. Stripe Connect wiring (online payment) | ⏳ S494 |
| 3. Appointments | ⏳ |
| 4. Per-vertical features (POS / work_orders / customer_vehicles) | ⏳ |

## What the next session should target

**Stripe Connect wiring for invoices.** Splits into:

1. Connect onboarding link endpoint — owner clicks "Set up
   payments" in Settings → gets a Stripe-hosted onboarding URL;
   business completes KYC; `businesses.connect_payouts_enabled`
   flips when ready.
2. PaymentIntent creation on Send — when an invoice is sent and
   the customer has email, generate a hosted-pay link
   (PaymentIntent with `transfer_data.destination` = the
   business's connect account).
3. Webhook handler — `payment_intent.succeeded` for business
   invoice intents marks the invoice paid + stamps
   `stripe_payment_intent_id` + amount.
4. Email send — customer receives the hosted-pay link in the
   email when the invoice goes from draft → sent.

Substantial but contained (one focused session).

---

End of S493 handoff. **Invoicing live as the first feature on
the S492 toggle infrastructure. Per-business monotonic
numbering. Full CRUD + manual lifecycle. Stripe Connect lands
S494.**

3141 tests / 165 files / 0 failures.

**Step 2 of the suite shipped (sans Stripe).**
