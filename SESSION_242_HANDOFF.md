# Session 242 — closed

## Theme

Stripe Terminal payment-processing flow — the S241 follow-up. Reader-
management infrastructure shipped S241; this session wires the
card-present PaymentIntent lifecycle (create → process-on-reader →
capture → cancel) on top of it, plus the validation gate in
`POST /pos/transactions` and webhook short-circuits for terminal PIs.

## Architecture confirmed

POS terminal PaymentIntents run **directly on the landlord's Connect
account** via `stripeAccount` override — no `transfer_data`, no
`application_fee_amount`. POS sales are landlord revenue minus
Stripe's IC+ rate; GAM's POS revenue is the monthly per-unit platform
fee (billed separately via the platform subscription engine), not a
per-transaction cut. Mirrors the S241 reader-management posture.

The reader is the landlord's. The PI is on the landlord's Connect.
The funds land in the landlord's Connect balance per their payout
schedule. GAM never intermediates POS revenue.

## Items shipped

### Service — `apps/api/src/services/posTerminal.ts`

5 new exports on top of the S241 reader-management functions:

| Function | Purpose |
|---|---|
| `createCardPresentPaymentIntent` | PI with `payment_method_types=['card_present']`, `capture_method='manual'`, metadata `{gam_purpose:'pos_terminal', gam_landlord_id, gam_property_id, gam_pos_draft_ref?}` under landlord's Connect |
| `processPaymentIntentOnReader` | `terminal.readers.processPaymentIntent` — server-driven push to smart readers (S700 / WisePOS E etc.); client-driven Bluetooth readers handle this via Terminal JS SDK in the browser, skipping this step |
| `captureTerminalPaymentIntent` | `paymentIntents.capture` — flips `requires_capture` → `succeeded`, settles auth |
| `cancelTerminalPaymentIntent` | `paymentIntents.cancel` — void-before-capture path for operator-voids / reader-timeouts / customer-walks |
| `retrieveTerminalPaymentIntent` | Used by `POST /pos/transactions` for the server-side validation gate |

All calls fire under `{ stripeAccount: landlordConnectAccountId }`.

### Routes — `apps/api/src/routes/pos.ts` (4 new)

| Route | Verb | Permission | Purpose |
|---|---|---|---|
| `/api/pos/terminal/payment-intents` | POST | `pos.ring_sale` | Create PI; validates property belongs to landlord; returns `{id, status, clientSecret}` |
| `/api/pos/terminal/payment-intents/:id/process` | POST | `pos.ring_sale` | Push to reader; validates reader belongs to landlord via `pos_terminal_readers` lookup; returns `{readerId, action}` for client polling |
| `/api/pos/terminal/payment-intents/:id/capture` | POST | `pos.ring_sale` | Capture; returns `{id, status, amount}` |
| `/api/pos/terminal/payment-intents/:id/cancel` | POST | `pos.ring_sale` | Cancel; returns `{id, status}` |

All four pull `landlordConnectAccountId` via the existing
`getLandlordConnectId(profileId)` helper from S241 (409 if landlord
hasn't completed Connect onboarding).

Helper added: `assertReaderBelongsToLandlord(landlordId, stripeReaderId)`
— scoped lookup against `pos_terminal_readers` for the process route.

### `POST /pos/transactions` — server-side PI validation gate

Pre-S242 the route accepted any `stripePaymentIntentId` without
validation; a malicious or misbehaving cashier could pass an
arbitrary id and stamp the transaction as paid. S242 adds:

```ts
if (paymentMethod === 'card' && stripePaymentIntentId) {
  const intent = await retrieveTerminalPaymentIntent({
    landlordConnectAccountId: connectId,
    paymentIntentId:          stripePaymentIntentId,
  })
  // 4 assertions:
  // 1. metadata.gam_purpose === 'pos_terminal'
  // 2. metadata.gam_landlord_id === caller's profileId
  // 3. status === 'succeeded'
  // 4. amount === Math.round(total * 100)
}
```

`payment_method` stays at `'card'` for terminal-captured sales — no
new CHECK value needed. The S94 design already assumed terminal-
captured PIs flow through this field; S242 just adds the integrity
check the field's presence implied.

### Webhook short-circuits — `apps/api/src/routes/webhooks.ts`

POS terminal PIs live on the landlord's Connect account; they have
no matching row in `payments` and need no GAM-side ledger write.
Existing handlers were functionally safe (the `UPDATE payments
WHERE stripe_payment_intent_id=$1` would return 0 rows), but
defensive early-out makes intent explicit:

- `payment_intent.succeeded`: if `metadata.gam_purpose==='pos_terminal'`,
  break before allocation / credit-ledger / OTP reconciliation
- `payment_intent.payment_failed`: if same, break before NACHA-retry /
  notification logic — card declined at the reader is operator-handled
  at POS, not a NACHA event

## Decisions made (S242)

| Question | Decision |
|---|---|
| Where does the PI live — platform Connect or landlord Connect? | Landlord. POS sales are landlord revenue. Reader, PI, funds all on landlord's account. No `transfer_data` / `application_fee`. |
| `capture_method` — automatic or manual? | Manual. Card-present convention; allows operator-cancel between auth and capture. Tipping flows would need it; even without tipping the explicit lifecycle is cleaner. |
| New `payment_method='terminal'` CHECK value? | No. S94 design already used `payment_method='card'` with `stripe_payment_intent_id` set; we keep that, add server-side validation. |
| Validate PI server-side before persisting transaction? | Yes — 4 assertions on retrieve(). Pre-S242 trusted client. |
| Both client-driven and server-driven reader flows? | Yes. Create-PI returns both `clientSecret` (for Terminal JS SDK Bluetooth path) and the PI `id`; `/process` route handles the smart-reader server-driven path. Capture + cancel work for both. |
| Webhook handlers — modify or short-circuit? | Short-circuit on `metadata.gam_purpose==='pos_terminal'`. Existing handlers are functionally safe but the explicit skip prevents future regressions (e.g., if someone adds a fallback path that doesn't require a payments-row match). |
| Currency configurable? | `usd` default with optional override. Hardcoding USD now would make a future CA / international expansion painful; the override is one line. |

## Files touched (S242)

```
apps/api/src/services/posTerminal.ts     (+ 5 service fns — create / process /
                                          capture / cancel / retrieve; ~135 new lines)
apps/api/src/routes/pos.ts               (+ 4 routes; + assertReaderBelongsToLandlord
                                          helper; ~ POST /transactions validates
                                          PI before insert; ~ extended import)
apps/api/src/routes/webhooks.ts          (~ payment_intent.succeeded early-out;
                                          ~ payment_intent.payment_failed early-out)
SESSION_242_HANDOFF.md                   (this file)
DEFERRED.md                              (tombstone terminal payment-flow entry)
```

No schema changes — `pos_transactions.stripe_payment_intent_id`
already exists with UNIQUE WHERE NOT NULL. The
`pos_transactions_payment_method_check` constraint
(`cash|card|charge`) stays as-is.

## Verification

- `cd apps/api && npx tsc --noEmit` → clean
- 4 new `POST /terminal/payment-intents*` routes registered alongside
  the S241 routes
- Webhook short-circuit branches typecheck against
  `Stripe.PaymentIntent.metadata`

## Carry-forward — S243+

### Pickable now

- **POS multi-terminal session sync** — when more than one cashier
  device on the same property. Likely premature; revisit when
  multi-cashier demand surfaces.
- **POS end-to-end smoke** (testing — Nic-runs) — Includes the new
  terminal flow now.
- **/resolve smoke** (testing — Nic-runs).

### Multi-session epics — pickable, no input needed

- **Flex Suite** (FlexPay / FlexCharge / FlexDeposit / FlexCredit
  tenant-side, hide behind launch flag). Flexion 8 deferred.
- **OTP full build** (landlord/tenant UI + advance-from-reserve
  disbursement + qualification-gate confirmation, hidden behind
  same launch flag).
- **Sublease subsystem** (greenfield, full scope pre-launch).

### Monday-trigger

- Checkr Partner post-approval items.

### Frontend POS terminal UI

Not yet wired — the backend lifecycle exists; the POS app
(`apps/pos`, port 3005) needs:
- "Charge to reader" button in the cart flow
- Reader selector (lists `/api/pos/terminal/readers?propertyId=...`)
- POST → create PI → push to reader → poll PI status → capture →
  POST /pos/transactions
- Cancel path on operator-void / customer-walk / reader-timeout
- Terminal JS SDK integration for Bluetooth-reader path (separate
  from server-driven smart-reader path)

This is the next logical scope — could land as S243 or batch with
POS multi-terminal session sync since both touch the POS frontend.

## Revised count

S242 closed 1 line item (Stripe Terminal payment-processing flow).
S241 reader-management + S242 payment flow together = full Stripe
Terminal backend.

| Bucket | Pre-S242 | Post-S242 |
|---|---|---|
| Pickable now | ~3 | ~2 (multi-terminal sync + frontend POS terminal UI) |
| Nic-blocked | 0 | 0 |
| External-vendor-blocked | 1 | 1 (Checkr Mon-trigger) |
| Multi-session epics | 3 | 3 (Flex / OTP / Sublease) |
| Pre-launch flag-gated | 2 | 2 (now actionable) |

**Until v1 launch-ready:** ~4–5 sessions (Flex / OTP / Sublease as
remaining multi-session epics; POS frontend UI + smoke as smaller
follow-ups; Checkr Mon-trigger ready).

---

End of S242 handoff.
