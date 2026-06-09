# Session 243 — closed

## Theme

Frontend POS terminal UI — closes the Stripe Terminal arc on top of
S241 (reader management) + S242 (PI lifecycle backend). The S242
handoff already named this as the next logical scope: charge-to-
reader button, reader selector, create→process/collect→poll→capture
flow, cancel path, Terminal JS SDK Bluetooth integration, and a
landlord-facing Readers management surface.

## Recon finding (drove the approach)

The POS app already had **partial scaffolding wired against a dead
endpoint**: `apps/pos/src/pages/POSPage.tsx` had a `chargeWithReader`
function, a reader-discovery modal, and `apps/pos/src/lib/terminal.ts`
with JS SDK helpers. But:

- `lib/terminal.ts → onFetchConnectionToken` POSTed to
  `/terminal/connection-token` (404). S241 moved the route to
  `/pos/terminal/connection-token`; the SDK had never worked.
- `chargeWithReader` POSTed to `/api/terminal/create-payment-intent`
  (also 404). The S242 route lives at `/api/pos/terminal/payment-
  intents` with different body shape (`amountCents`, `propertyId`,
  `description?`, `posDraftRef?`).
- `checkoutMut` never passed `stripePaymentIntentId` → the S242
  backend gate (`metadata.gam_purpose='pos_terminal'` + amount +
  status check) never had anything to validate.
- The capture step was missing entirely — `capture_method='manual'`
  means the PI would sit in `requires_capture` forever after auth.
- No surface existed for the S241 reader CRUD; landlords could
  register readers only by hitting the API directly.

Per the memory rule on underwired infra: wire it, don't rip it out.

## Items shipped

### Backend — `apps/api/src/routes/pos.ts` (1 new route)

| Route | Verb | Purpose |
|---|---|---|
| `/api/pos/terminal/payment-intents/:id` | GET | Poll PI status under landlord's Connect account. Returns `{id, status, amount, lastPaymentError}`. Used by smart-reader server-driven flow polling after `/process` push. Same `metadata.gam_landlord_id` ownership check as the rest of the terminal routes. |

The existing `retrieveTerminalPaymentIntent` service from S242 is
reused — no new service code, just a new HTTP surface.

### Frontend — `apps/pos/src/lib/terminal.ts` (rewrite)

Endpoint path fix + new lifecycle helpers, all routed through the
S243 backend routes. The JS SDK Bluetooth path (`discoverReaders`,
`connectReader`, `collectCardPayment`, `cancelCurrentPayment`)
stays for the handheld-reader client-driven flow.

| Export | Purpose |
|---|---|
| `createTerminalIntent(amountCents, propertyId, description?, posDraftRef?)` | POST `/pos/terminal/payment-intents` |
| `processIntentOnReader(paymentIntentId, stripeReaderId)` | POST `…/:id/process` |
| `captureTerminalIntent(paymentIntentId)` | POST `…/:id/capture` |
| `cancelTerminalIntent(paymentIntentId)` | POST `…/:id/cancel` |
| `retrieveTerminalIntent(paymentIntentId)` | GET `…/:id` |
| `pollPiUntilTerminal(piId, {timeoutMs, intervalMs})` | Polls every 2s up to 60s. Resolves on `requires_capture` / `succeeded` / throws on `canceled` / `last_payment_error` / timeout. |
| `listRegisteredReaders(propertyId?)` | GET `/pos/terminal/readers` |
| `registerNewReader({propertyId, registrationCode, nickname, label?})` | POST `/pos/terminal/readers` |
| `archiveRegisteredReader(id)` | DELETE `/pos/terminal/readers/:id` |

Two parallel paths converge on the backend PI lifecycle:
- **Smart reader** (`type:'smart'`): GAM-registered S700 / WisePOS E.
  Backend pushes PI via `/process`; frontend polls; backend captures.
- **Bluetooth** (`type:'bluetooth'`): handheld discovered by the SDK
  in-browser. SDK collects card with `clientSecret`; backend captures.

Bug fix: `discoverReaders` was reading `process.env.NODE_ENV` for
the `simulated` flag — Vite doesn't expose that in the browser
bundle. Now uses `import.meta.env.DEV`.

### Frontend — `apps/pos/src/pages/POSPage.tsx`

**Register tab (cart panel):**
- New property selector when `method==='card'` — required to enable
  the Charge button. Auto-picks for single-property landlords; only
  rendered as a dropdown when 2+ properties exist.
- New "Reader" picker button under the property selector — opens the
  reader-selection modal. Shows the active reader's nickname (smart)
  or label (Bluetooth) when one is selected.
- `chargeWithReader` rewrite — full lifecycle: create PI → branch
  (smart: process+poll OR bluetooth: SDK collect) → capture → POST
  `/pos/transactions` with `stripePaymentIntentId`. On any error,
  `cancelTerminalIntent(piId)` is best-effort to keep the landlord's
  Connect account clean.
- `checkoutMut` now accepts an optional `stripePaymentIntentId` arg
  and passes it in the POST body — feeds the S242 validation gate.
- Charge button disabled states extended: `terminalStatus==='collecting'
  /'capturing'` blocks double-clicks; `method==='card' && !registerProperty`
  blocks the no-property case. Button label reflects state
  ('Awaiting card…', 'Capturing…').
- Inline status display in the cart panel (waiting / capturing /
  error message).

**Reader selection modal (rewrite):**
- Two sections: "Registered readers" (smart, filtered by selected
  property; from S241 `pos_terminal_readers`) and "Bluetooth readers"
  (SDK-discovered; Discover button on demand).
- Single `activeReader` state replaces the old `connectedReader`
  (discriminated union: `{type:'smart',…} | {type:'bluetooth',…}`).

**Readers tab (new):**
- Pair-new-reader form (propertyId + pairing code + nickname).
  Pairing code is the human-readable one the device shows in pairing
  mode; backend trades it for a persistent Stripe reader id via the
  S241 `registerReader` service.
- Active readers table: nickname, property, Stripe id, registered
  date, archive button. Archive is soft (status='archived' in
  `pos_terminal_readers`); Stripe-side record stays for the
  landlord to delete from their Stripe dashboard if desired.

## Decisions made (S243)

| Question | Decision |
|---|---|
| Wire existing dead-endpoint scaffolding or replace it? | Wire it. The lib/terminal.ts JS SDK shell + the modal + the chargeWithReader entry point all stayed; just the endpoint paths, body shape, and capture step were missing. Per memory rule: don't rip out underwired infra. |
| Where does the smart-reader selector live? | Same modal as Bluetooth discovery. Two labeled sections, both reachable from one "Reader" button. Avoids fragmenting the cashier's mental model — they're picking a reader, full stop. |
| New `GET /pos/terminal/payment-intents/:id` polling route, or use webhooks? | Polling. Webhooks require server-side state (Connect-account event routing), and the smart-reader flow needs ~30-60s of synchronous "is the customer done tapping?" attention. Polling is cheap, deterministic, and self-cleaning on timeout. |
| Polling cadence? | 2s interval, 60s timeout. Covers customer walk-up reading; long enough for tap+PIN; short enough that a true reader-jammed state surfaces fast. Tunable via opts. |
| Property selector — required for all sales or only card? | Card only. Cash and on-tenant-charge don't create PIs; the PI is the only consumer of propertyId. Don't gate non-card sales on UI the cashier doesn't need. |
| Auto-pick property for single-property landlords? | Yes. Multi-property landlords are the exception; single-property is the common case and shouldn't require a click. |
| Archive smart readers from the UI? | Yes — soft archive (S241 already implements). Adds an audit trail (`status='archived'`) without touching Stripe; landlord can delete on Stripe's side if they want a hard purge. |
| Cancel SDK collect on Bluetooth-path errors? | Yes, plus cancel the PI itself. The SDK has its own cancel surface (`cancelCollectPaymentMethod`); the PI needs its own cancel (the SDK doesn't touch server-side PI state). Both fire best-effort with `.catch(()=>{})`. |
| Posting `stripePaymentIntentId` — null for non-card? | Yes, explicitly. The S242 gate only runs when `paymentMethod==='card' && stripePaymentIntentId` — passing `null` cleanly bypasses for cash/charge. |

## Files touched (S243)

```
apps/api/src/routes/pos.ts                    (+ GET /terminal/payment-intents/:id
                                                ; ~25 lines)
apps/pos/src/lib/terminal.ts                  (rewrite — endpoint-path fix +
                                                10 lifecycle helpers; ~200 lines)
apps/pos/src/pages/POSPage.tsx                (+ ActiveReader union type; +
                                                property selector + reader picker
                                                in cart; rewrite chargeWithReader
                                                + selectSmartReader / selectBluetoothReader;
                                                stripePaymentIntentId in checkoutMut;
                                                + Readers tab UI + register/archive
                                                mutations; ~210 lines net)
DEFERRED.md                                   (~ tombstone POS terminal frontend
                                                shipped)
SESSION_243_HANDOFF.md                        (this file)
```

No schema changes. No new shared exports. No new dependencies (the
`@stripe/terminal-js` SDK was already in `apps/pos/package.json`).

## Verification

- `cd apps/api && npx tsc --noEmit` → clean (0 errors)
- `cd apps/pos && npx tsc --noEmit` → clean (0 errors)
- All 9 backend routes accounted for: connection-token, readers
  (POST/GET/DELETE), payment-intents (POST/GET/process/capture/cancel)
- Endpoint paths in frontend match backend exactly (verified via grep)

## Carry-forward — S244+

### Pickable now

- **POS multi-terminal session sync** — only relevant when 2+ cashier
  devices ring on the same property simultaneously. Likely still
  premature; revisit when demand surfaces.
- **POS end-to-end smoke** (Nic-runs) — now includes the full terminal
  charge flow end-to-end. Covers: pair-reader → sale → reader prompt
  → capture → transaction → inventory delta → low-stock alert →
  auto-draft PO → vendor receive → restock.
- **/resolve smoke** (Nic-runs).

### Multi-session epics — pickable, no input needed

- **Flex Suite** (FlexPay / FlexCharge / FlexDeposit / FlexCredit
  tenant-side, hide behind launch flag).
- **OTP full build** (landlord/tenant UI + advance-from-reserve
  disbursement + qualification-gate confirmation, hidden behind
  the same launch flag).
- **Sublease subsystem** (greenfield, full pre-launch scope).

### Monday-trigger

- Checkr Partner post-approval items. Today is 2026-05-11 (Monday) —
  worth checking status if Nic has heard back.

## Revised count

S243 closes the POS Terminal frontend line item. S241 reader CRUD +
S242 PI lifecycle + S243 frontend = full Stripe Terminal stack.

| Bucket | Pre-S243 | Post-S243 |
|---|---|---|
| Pickable now | ~2 | ~1 (multi-terminal sync, still likely premature) |
| Nic-blocked | 0 | 0 |
| External-vendor-blocked | 1 | 1 (Checkr Mon-trigger — today!) |
| Multi-session epics | 3 | 3 (Flex / OTP / Sublease) |
| Pre-launch flag-gated | 2 | 2 |

**Until v1 launch-ready:** ~3-4 sessions (Flex / OTP / Sublease as
remaining multi-session epics; Checkr Mon-trigger ready to land
when partner credentials arrive).

---

End of S243 handoff.
