# Session 170 — closed

## Theme

Tenant rent payment — card path. Direct continuation of S169 (which
shipped the ACH-only first cut). Closes the rent-payment surface
end-to-end: tenants can now pay rent through GAM with either an
ACH bank account or a credit/debit card, with the backend
correctly computing GAM's application fee per S113 pricing
(1.0% capped $6 ACH, 3.25% flat card, +1.5% non-US-issued cards,
plus tenant-payer platform-fee accrual passthrough).

## What S170 shipped

### Backend — `/api/stripe/tenant/setup` extended for card

Same endpoint, new `method?: 'ach' | 'card'` body parameter.
Default `'ach'` for back-compat with any caller that hasn't
been updated.

- **ACH path (unchanged behaviour):** SetupIntent with
  `payment_method_types: ['us_bank_account']` and Financial
  Connections enabled. Frontend must POST `/tenant/confirm-setup`
  on success — server flips `tenants.ach_verified`, stamps
  `bank_last4` / `bank_routing_last4`, logs first-sender to
  `ach_monitoring_log`.
- **Card path (new):** SetupIntent with
  `payment_method_types: ['card']`, `usage: 'off_session'`. No
  Financial Connections. On `confirmSetup` success Stripe
  automatically attaches the resulting `payment_method` to the
  customer — no server-side capture step required, the next
  `/payment-methods` GET returns the card.
- **Customer create:** ACH first-time setup still uses
  `createTenantAchSetup` (which both creates the customer and
  returns the first SetupIntent in one shot — preserves S84
  semantics). Card first-time setup creates a bare customer
  here inline before issuing the SetupIntent.
- **Role gate:** added explicit `req.user.role === 'tenant'`
  guard on the endpoint while we were in there. Pre-S170 it was
  guarded only by the SELECT FROM tenants WHERE id = profileId
  pattern (which 404s for non-tenants but isn't the right gate
  shape).

### Frontend — `apps/tenant/src/pages/PaymentsPage.tsx`

Rebuilt to surface card flow alongside ACH:

- **Header:** two CTAs — `+ Add bank` and `+ Add card`. Both
  open the unified `AddPaymentMethodModal`.
- **`AddPaymentMethodModal`:** absorbs the S169 `AddBankModal`.
  Takes a `method: 'ach' | 'card'` prop. Same two-phase shape
  (POST `/tenant/setup` → mount Stripe Elements → confirmSetup
  → success). Different copy per method ("Add a bank account" /
  "Add a card", different idle/loading/done lines), and the
  card path skips the `/confirm-setup` server roundtrip.
- **`PaymentMethodSetupForm`:** absorbs S169 `AchSetupForm`.
  Method-aware confirm flow: ACH posts `/confirm-setup`; card
  is done as soon as `confirmSetup` resolves with a
  payment_method.
- **`PayNowModal`:** picker now shows two sections —
  Bank accounts and Cards — when both have entries. Each
  section has its own `+ Use a different bank` / `+ Use a
  different card` link. When only one method type exists, the
  "+ Add a {bank,card}" CTA appears as a footer link to make
  the alternative discoverable. Selection radio is shared
  across both lists; on submit the frontend reads
  `selectedMethod.type` and posts
  `payment_method_type: 'ach' | 'card'` accordingly.
- **Authorization copy:** dynamic per-method footer beneath
  the Pay button:
  - ACH: "By clicking Pay you authorize a one-time ACH debit
    from the selected account. ACH typically settles in 3–5
    business days."
  - Card: "By clicking Pay you authorize a one-time charge to
    the selected card. Card payments include a 3.25%
    processing fee (plus 1.5% for non-US-issued cards) which
    may be passed through depending on your landlord's
    settings."
- **Success copy** branches on method too: card success says
  "Card charged. Receipt emailed."; ACH says "Payment
  submitted. ACH typically settles in 3–5 business days."
  Card payments stamp `payments.status = 'settled'` immediately
  in the backend (per S117 logic); ACH lands as `'processing'`
  until the webhook flips it later.
- **`SavedMethodsCard` empty state:** updated copy now
  references both `+ Add bank` and `+ Add card`.
- **Reusable picker primitives:** `MethodPickerSection` and
  `PickerRow` extracted so the radio-style picker can render
  both bank and card sections without copy-paste.

### Files touched (S170)

```
apps/api/src/routes/stripe.ts                                           (POST /tenant/setup body method param + tenant role gate; card SetupIntent branch)
apps/tenant/src/pages/PaymentsPage.tsx                                  (header CTAs, unified AddPaymentMethodModal, two-section picker, dynamic copy)
```

### Verification

- `cd apps/api && npx tsc --noEmit` exit 0
- `cd apps/tenant && npx tsc --noEmit` exit 0
- Backend `/api/payments/:id/pay` already accepts
  `payment_method_type: 'card'` (S117 destination charges) and
  `services/stripeConnect.ts → computeApplicationFee` already
  handles the 3.25% + Canadian-card +1.5% correctly. No backend
  pricing changes needed; this session was purely UI/setup-flow
  enabling the existing rails.

## Decisions made (S170)

| Question | Decision |
|---|---|
| One endpoint with `method` param, or new `/tenant/setup-card`? | Extended existing endpoint with optional `method` body. Default 'ach' preserves back-compat with any caller; explicit branching inside the handler keeps the shared customer-create path coherent. |
| Server-side capture step for card? | Skipped. SetupIntent w/ `customer` set auto-attaches the card on confirmSetup success; the next `/payment-methods` GET returns it. The ACH-side `/confirm-setup` exists specifically to flip `ach_verified` + log first-sender — neither applies to cards. |
| Two near-identical add-method modals, or unified? | Unified. ACH and card flows are 90% identical (POST setup → mount Elements → confirmSetup); the diff is one `if (method === 'ach') postConfirmSetup(...)` branch + copy. A unified component avoids the maintenance drift of two parallel paths. |
| Picker selection model — separate by type or single radio? | Single radio across both sections. The submit handler reads `selectedMethod.type` to send the right `payment_method_type`. Means a tenant choosing between "ACH from Chase" and "Visa ending 4242" is one click, not two. |

## Carry-forward — what S171 should target

### Tenant utility-bill payment surface (most launch-aligned next step)

Backend `POST /api/utility/bills/:id/pay` is fully wired
(`apps/api/src/routes/utility.ts:360`) — same body shape as
rent (`{ payment_method_id, payment_method_type }`), same
destination-charge math, same tenant-payer surcharge
passthrough. Frontend `UtilitiesPage` in
`apps/tenant/src/main.tsx:2001` is read-only history with **no
Pay button**. Same pattern gap as `/payments` was pre-S169.

Two related cleanups in the same touch:
1. **Display columns are broken** — UtilitiesPage references
   `b.utilityCost`, `b.adminFee`, `b.totalAmount`,
   `b.usageAmount` for the table cells. The wire response
   from `GET /api/utility/bills` returns
   `chargeAmount`, `usageAmount`, `billedAt`, `utilityType`,
   `propertyName`, `meterLabel`, `unitNumber`, `status` — most
   referenced fields don't exist (rendering "undefined" in
   four columns today). Per fix-it-right, swap the column set
   for fields that actually exist when wiring the Pay button.
2. **Generalize `PayNowModal`** in `pages/PaymentsPage.tsx` —
   parameterize the pay endpoint URL + the line-item amount/
   description so UtilitiesPage can reuse it. Or: extract a
   small `PayMethodPicker` that both pages mount and supply
   their own submit handler. Either shape works.

Estimated 1 session (probably half a session given how much
overlap with S169/S170 exists).

### Tenant rent-pay smoke test (manual, blocked on Stripe creds)

Now covers both ACH + card. Steps in
SESSION_169_HANDOFF.md still apply — additionally:

- Click `+ Add card`, complete `4242 4242 4242 4242` test
  card flow.
- Click Pay Now on a pending row, pick the card. Confirm
  `payments.status` flips to `'settled'` immediately
  (per S117 card branch) and `application_fee_amount` reflects
  3.25% (or 4.75% if a non-US test card was used).
- Repeat with a Canadian test card (e.g.
  `4000 1240 0000 0000`) to verify the +1.5% surcharge fires
  via `computeApplicationFee`.

### Already-known carry-forward (still open, unchanged)

- **Strip mock `AchVerifyForm`** in `main.tsx:643` — blocked
  on Nic greenlighting OTP UI.
- **`apps/admin/src/main.tsx` split** — mechanical refactor,
  no product gain, no urgency.
- **Stripe-Custom-controller migration** — removes "Powered by
  Stripe" branding on embedded onboarding; takes on GAM's
  KYC build burden. Real product call, not a cleanup.
- **Per-state tax form catalog** (`state_forms` table) — Item
  3 STILL OUTSTANDING from DEFERRED. Product-scoped follow-up.
- **Frontend bookkeeper invite UI** for the books portal
  (Item 3 STILL OUTSTANDING). Backend endpoints live; UI glue
  is its own session.

---

End of S170 handoff.
