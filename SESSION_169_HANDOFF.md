# Session 169 — closed

## Theme

Tenant rent payment frontend — closes the largest gap between
"S113 Connect rebuild done" and "actually take money." Pre-S169
the backend `POST /api/payments/:id/pay` (S117 destination charges
+ tenant-payer surcharge passthrough) was fully wired but had
zero frontend consumer; the tenant `/payments` page was a
read-only history table. Tenants literally could not pay rent
through GAM. ACH-only first cut shipped this session; card path
deferred (computeApplicationFee + the /pay endpoint already
accept type:'card' so the wiring is one Stripe Elements form
away).

## What S169 shipped

### S168 carry-forward reconcile

S168's "legacy disbursements queue cleanup" carry-forward was
re-recon'd at start of S169 and is **already done**:

- `services/disbursementFiring.ts` deleted (S167) — confirmed,
  zero refs anywhere in `apps/api/src`.
- `routes/withdrawals.ts` is **NOT** a legacy retry surface —
  it's the current S113-Phase5 Stripe-Payouts manual-payout
  endpoint (live code).
- `routes/admin.ts:445` is no longer a legacy retry endpoint —
  that line is now part of the audit-log handler. No
  `disbursementFiring` / `DISBURSEMENT_RAIL` refs anywhere in
  the route.
- The doc comment at `lib/stripe.ts:51-57` flagged in S168 as
  stale is in fact already accurate — explicitly references S113
  destination charges + `services/stripeConnect.ts`.

Net: the only real residue was 2 dead helpers in `lib/stripe.ts`
(see warmup below). S168 carry-forward closed in full.

### Warmup — `lib/stripe.ts` dead-code strip

- `createRentPaymentIntent` (36 lines) deleted. Zero callers
  anywhere. Superseded by
  `services/stripeConnect.ts → createRentDestinationCharge` /
  `createRentPlatformCharge` under S113.
- `calcStripeRentCost` (7 lines) deleted. Zero callers + stale
  pricing math (0.8% capped $5 — the locked S113 model is 1.0%
  capped $6 ACH, 3.25% flat card). Pricing now lives in
  `services/stripeConnect.ts → computeApplicationFee` with the
  Canadian-card USD surcharge bake-in.
- The `// S113 (current architecture)` doc comment at line 51
  remains and is correct.

### Backend — `GET /api/stripe/tenant/payment-methods`

New endpoint at `apps/api/src/routes/stripe.ts`. Lists the
calling tenant's saved Stripe payment methods (us_bank_account
+ card in parallel via `Promise.all`). Returns a clean
discriminated-union shape:

```ts
type SavedPaymentMethod =
  | { id; type: 'ach'; bankName; last4 }
  | { id; type: 'card'; brand; last4; expMonth; expYear; country }
```

Card slot included for forward-compat — UI shape is stable when
the card-add flow lands. Tenants without a `stripe_customer_id`
yet get an empty array (200, not 404). Auth: `requireAuth` on
the router + role:'tenant' guard inside the handler.

### Frontend — new `apps/tenant/src/pages/PaymentsPage.tsx`

Replaces the inline `PaymentsPage` in `main.tsx` with a real
pay-rent surface. Features:

- **Saved methods card** above the history table — shows ACH
  banks and (when added) cards already on the tenant's Stripe
  customer.
- **Pay Now button** on every `pending` / `failed` payment row.
  Opens a modal with a radio picker of saved ACH methods. Selecting
  one → `POST /api/payments/:id/pay { payment_method_id,
  payment_method_type:'ach' }`. Success copy explains 3–5 day
  ACH settlement window; modal auto-closes on success and
  invalidates both `payments` and `tenant-payment-methods`
  query caches.
- **+ Add bank** CTA in the header (and inside the Pay Now
  modal when no methods are on file). Two-phase flow:
  1. `POST /api/stripe/tenant/setup` returns a SetupIntent
     `clientSecret` with Financial Connections enabled (instant
     verification — no micro-deposits).
  2. Stripe Elements `<PaymentElement />` rendered inside
     `<Elements clientSecret={...} />`. On `confirmSetup` success
     the resulting `payment_method` id is POSTed back to
     `/api/stripe/tenant/confirm-setup` which writes
     `tenants.ach_verified`, `bank_last4`, `bank_routing_last4`
     and an `ach_monitoring_log` first-sender row (existing
     server-side flow).
- **Stripe-not-configured fallback**: when
  `VITE_STRIPE_PUBLISHABLE_KEY` is unset (dev without Stripe
  creds), the Add Bank modal shows an inline warning instead of
  silently failing.
- Same gold/dark theme primitives as the rest of the tenant
  portal (`.btn`, `.card`, `.alert`, `.badge`, `var(--gold)`).

The existing `LandlordBankingBanner` from `main.tsx` (which
warns the tenant when their landlord hasn't completed Connect
onboarding) is passed in as a prop so the new page renders it
in the same slot as before.

### Files touched

```
apps/api/src/lib/stripe.ts                                              (− createRentPaymentIntent, − calcStripeRentCost, doc-comment refresh)
apps/api/src/routes/stripe.ts                                           (+ GET /tenant/payment-methods)
apps/tenant/src/pages/PaymentsPage.tsx                                  NEW (621 lines — page + modals + Stripe Elements wiring)
apps/tenant/src/main.tsx                                                (replaces inline PaymentsPage with import; LandlordBankingBanner passed as prop)
```

### What was deliberately left alone

- **Mock `AchVerifyForm` at `main.tsx:643`** — still gated
  behind the OTP qualification flow on ServicesPage. Per
  CLAUDE.md memory ("FlexSuite + OTP stay hidden in portals
  until Nic greenlights"), OTP UI is hold-pattern. Once a
  tenant verifies a real bank via the new Pay Now flow,
  `tenants.ach_verified` flips server-side and the OTP gate
  unblocks "for free" — but the existing scaffold isn't being
  ripped out without explicit greenlight.
- **Card-add flow** — new card on the tenant's Stripe customer.
  Elements + SetupIntent shape is similar but not identical
  (cards usually flow through a CheckoutSession or a
  PaymentMethod create-and-attach; Financial Connections doesn't
  apply). One follow-on session.

### Verification

- `cd apps/api && npx tsc --noEmit` exit 0
- `cd apps/tenant && npx tsc --noEmit` exit 0
- `VITE_STRIPE_PUBLISHABLE_KEY` already documented at
  `.env.example:23` (commented; same env var the
  BackgroundCheckPage Elements wiring already uses).
- Schema column `tenants.stripe_customer_id` confirmed via
  `apps/api/src/db/schema.sql`.

## Decisions made (S169)

| Question | Decision |
|---|---|
| Scope: warmup-only vs real launch blocker? | Bundled — small `lib/stripe.ts` strip + the real tenant pay-rent rebuild. The warmup was ~10 min of dead-code removal; the meat was the missing pay-rent UI, which is the largest remaining "S113 done backend / nothing on the frontend" gap. |
| ACH-only vs ACH + card same session? | ACH-only. Rent is overwhelmingly ACH; card adds a separate Stripe Elements flow shape (cards-on-customer, no Financial Connections), and the Pay Now picker shape already accommodates card entries — wiring the add-card surface is the only delta. |
| Inline in `main.tsx` vs new file? | New `pages/PaymentsPage.tsx`. main.tsx is already 2100+ lines; loading another 600-line page inline would cement the pattern. Other tenant pages (`SignPage`, `LeasePage`, `ProfilePage`, `BackgroundCheckPage`) all live under `pages/` — this is the same posture. |
| Touch the mock OTP-gate `AchVerifyForm`? | No. CLAUDE.md memory holds OTP UI in hide-pattern until greenlight; the form is unreachable in practice once a tenant adds a real bank via Pay Now (since `ach_verified` flips server-side). Ripping it without explicit ask is scope creep. |
| Refactor `main.tsx` get/post helpers into a shared `lib/api.ts`? | Deferred. The new page wires its own axios instance + `get`/`post` helpers (mirrored from `main.tsx`). Pulling into a shared module is its own cleanup pass. |

## Carry-forward — what S170 should target

### Tenant pay-rent: card path

ACH lands rent ~99% of the time but card is needed for the
launch surface (urgent payments, late fees that need same-day
settlement, foreign tenants without US bank accounts). Required:

1. New `+ Add card` CTA on PaymentsPage / inside Pay Now modal.
2. SetupIntent for `payment_method_types: ['card']` (no
   Financial Connections) at backend
   `/api/stripe/tenant/setup-card` (new) or extend the existing
   `/setup` to take a method-type body parameter.
3. Stripe Elements `PaymentElement` with `paymentMethodTypes`
   restricted to card.
4. After confirm-setup, the existing
   `GET /tenant/payment-methods` endpoint already returns the
   card row in the right shape; UI need only render it.
5. Pay Now picker: when the selected row is a card, send
   `payment_method_type:'card'` to `/payments/:id/pay`. Backend
   already supports this and computes the application fee
   (3.25% + Canadian USD surcharge) correctly.

Estimated 1 session.

### Tenant utility-bill payment surface

Same shape gap as rent: `routes/utility.ts` has the destination
charge wired (per S117 mirror); tenant `/utilities` page has
no "Pay" button. Once the rent card-path lands, this is a
small extension — same Pay Now modal, different
`/utility-bills/:id/pay` endpoint shape.

### Tenant rent-pay smoke test (manual, blocked on Stripe creds)

When `VITE_STRIPE_PUBLISHABLE_KEY` + `STRIPE_SECRET_KEY` are
set with test creds:

1. Tenant logs in, goes to `/payments`, clicks **+ Add bank**.
2. Stripe Financial Connections sandbox flow runs. Pick the
   "Test Bank — instant verification" path.
3. Verify `tenants.ach_verified` flips TRUE in DB; the new
   bank shows in the Saved Methods card.
4. Click **Pay now** on a pending row → pick the bank → confirm.
5. `payments.status` flips to `'processing'`,
   `stripe_payment_intent_id` is stamped, the in-flight
   PaymentIntent appears in the Stripe dashboard with the
   correct `application_fee_amount` and `transfer_data.destination`
   (or no destination + `platform_held=true` if the landlord
   isn't Connect-ready yet).
6. Webhook `payment_intent.succeeded` later flips
   `payments.status` to `'settled'` and runs the allocation
   engine.

### Strip mock `AchVerifyForm` once OTP is greenlit

Either (a) Nic greenlights OTP → keep the form but route it
through real Stripe SetupIntent, or (b) delete the form +
the OTP gate copy entirely. Either path unblocks the same way
the rent-pay flow now does.

### Non-Stripe-related items (still open from S168 / earlier)

- `apps/admin/src/main.tsx` split (~1700 lines, ~16 inline
  page funcs) — mechanical refactor, no product gain. Whenever
  that file is next touched for a real change.
- Stripe-Custom-controller migration — removes the visible
  "Powered by Stripe" branding on embedded onboarding but
  takes on GAM's KYC build burden. Real product call, not a
  cleanup.

---

End of S169 handoff.
