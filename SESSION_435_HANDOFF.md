# Session 435 — closed

## Theme

**Twelfth services-audit session. Second slice of the
`stripeConnect.ts` arc — destination-charge + transfer
surface. 17 tests pinning the S113 PaymentIntent shape
(destination charges + platform safety valve), the PM
company Transfer wrapper, and the generic ledger-driven
firing helper.**

Suite at S434 close: **2294 / 132 files**.
Suite at S435 close: **2311 / 133 files** (+17 cases,
+1 file). 0 failures. Runtime **64.98s**.
Thirty-ninth consecutive fully-green full-suite run.

Zero tsc regressions.

## What shipped

### `services/stripeConnectCharges.test.ts` — 17 cases

Four exports covered. New file (not appended to S434's
`stripeConnect.test.ts`) so vitest's per-file mock
isolation keeps clean boundaries.

**`createRentDestinationCharge` (4)**
- ACH happy: cents conversion, transfer_data.destination,
  application_fee_amount, mandate_data (online customer
  acceptance), payment_method_options.us_bank_account
  with `financial_connections.permissions=['payment_method']`
- Card happy: NO mandate_data, NO payment_method_options
  (per S64 — only ACH needs the mandate + Connections shape)
- Caller metadata merges with entry_description
- Cents rounding on fractional dollars ($33.33 → 3333;
  $1.234 fee → 123)

**`createRentPlatformCharge` (3)**
- No transfer_data, no application_fee_amount (gross goes
  to platform balance entirely)
- metadata.platform_held = 'true' (caller flips
  payments.platform_held to match)
- ACH path adds mandate_data + financial_connections (same
  shape as the destination-charge variant)

**`createPmCompanyTransfer` (3)**
- Cents conversion + destination + metadata + default
  description 'PM company fee'
- sourceTransactionId pass-through (S113-Phase2.5 charge
  sourcing — funds the transfer from the original charge
  instead of platform balance)
- Custom description overrides default

**`firePmTransfersForReference` (7)**
- No unfired rows → fired:0 failed:0; no Stripe call
- Happy: fires Transfer + stamps stripe_transfer_id on
  the ledger row; metadata stamps gam_ledger_id +
  gam_reference_id + gam_reference_type
- reference_type='payment' + payments.stripe_charge_id NOT
  NULL → passes as source_transaction
- reference_type='lease' → no charge lookup; transfer
  omits source_transaction
- PM user has no Connect account → failed++ ; no Stripe
  call for that row
- Already-fired row (stripe_transfer_id NOT NULL) →
  excluded from the SQL query; no Stripe call
- Stripe Transfer error → failed++ + admin notification
  (severity='warn', category='pm_transfer_failed');
  ledger row left unstamped for retry

## Items shipped

```
apps/api/src/services/
  stripeConnectCharges.test.ts          (NEW — 17 cases)
```

No source code changes. Service preserved as-is.

## Decisions made during build

| Question | Decision |
|---|---|
| Append to `stripeConnect.test.ts` or new file? | **New file.** Per-file vitest mock isolation; the S434 mocks set up different Stripe surfaces (`accounts`, `accountSessions`) than S435 (`paymentIntents`, `transfers`). Mixing them risks cross-test interference. |
| Pin the cents-rounding contract? | **Yes — load-bearing.** Stripe amounts are in minor units. A regression that drops `Math.round` would charge or transfer slightly-wrong amounts; off-by-cent ledger drift compounds. |
| Pin the ACH `financial_connections.permissions=['payment_method']` shape? | **Yes — S64 architectural decision.** Without this, ACH PaymentIntents fail at confirm time with "missing permissions". A regression that drops the field would silently break all rent ACH. |
| Pin the metadata.platform_held='true' on the platform charge? | **Yes — required for downstream.** The webhook handler reads this flag to flip `payments.platform_held=TRUE`. A regression that drops it would leave platform-held payments unflagged and unreconcilable. |
| Pin the S113-Phase2.5 source_transaction routing? | **Yes — money-movement load-bearing.** Without source_transaction, Stripe pulls from platform balance — which under destination-charges only contains app fees, not the full gross. A regression would cause "insufficient balance" failures on PM transfers. |
| Pin the admin notification on Stripe transfer failure? | **Yes — operational visibility.** Per source comment S132: "warn — PM cut didn't transfer; ghost row stays on the ledger pending re-fire. Reconciliation will retry, but admin sees the failure rate so they know if Stripe is having a bad day." The notification IS the visibility channel. |
| Cover multi-row counter explicitly? | **No.** The (reference_id, reference_type, type) UNIQUE on `user_balance_ledger` means at most one `allocation_pm_company_fee` row per reference; multi-row scenarios aren't reachable in production. Removed the test after hitting the constraint. |

## Verification

- `npx tsc --noEmit` clean on apps/api (0 errors).
- `npm test` in apps/api: **2311 tests across 133
  files, 0 failures**, 64.98s. **Thirty-ninth
  consecutive fully-green full-suite run.**
- 17 new test cases.
- 0 production regressions.
- 0 new findings — service matches contract.

## Services audit — progress

Post-S435:

### Direct coverage (42 of 43 services; stripeConnect 10/12)

stripeConnect.ts arc:
- S434 (account-management): ensureConnectAccount,
  createOnboardingSession, fetchAccountStatus,
  computeApplicationFee, recordAccountUpdated
- S435 (charges + transfers): createRentDestinationCharge,
  createRentPlatformCharge, createPmCompanyTransfer,
  firePmTransfersForReference
- Previously covered: fireManagerTransfersForReference
  (`stripeConnectTransfers.test.ts`)
- **Remaining for S436**: recordPayoutEvent (heavy),
  recordDisputeEvent (medium)

### Still UNCOVERED (~13 files post-S435)

Highest-value next candidates:
1. **stripeConnect.ts webhook recorders** (S436 — close
   out the arc with recordPayoutEvent +
   recordDisputeEvent)
2. **pm.ts invitation lifecycle** (continuation of S428)
3. **flexCharge.ts billing/reconciliation half**
   (continuation of S425)
4. **otp.ts Stripe state-machine half**
   (continuation of S427)
5. **flexpay.ts Stripe state-machine half**
   (continuation of S431)
6. **DB-backed credit-ledger wrappers**
   (continuation of S429)
7. Plus ~7 smaller helpers

## Items deferred — what S436 could target

### Close the stripeConnect.ts arc

**Recommend S436 = stripeConnect webhook recorders
(`recordPayoutEvent` + `recordDisputeEvent`).** Both
read Stripe webhook events and persist to GAM tables;
shared mock setup with S434/S435. Closes the arc at
12/12 functions covered.

**Alternatives:**
- pm.ts invitation lifecycle (continuation of S428)
- flexCharge.ts billing/reconciliation half
- Roll through smaller helpers (faster cadence)

### Validation-hygiene backlog (16 items)

Unchanged from S427.

### Cumulative bug-sweep totals (post-S435)

- **47 production bug fixes** (S435 is direct coverage)
- 16 architectural / validation findings remaining
- 2311 tests across 133 files
- Suite baseline: **60-65s on a clean machine**

## What S436 should target

**Recommended: stripeConnect webhook recorders
(`recordPayoutEvent` + `recordDisputeEvent`).** Closes
the 12-function arc. Same Stripe + adminNotifications
mock pattern as S434/S435.

**Alternatives:**
- pm.ts invitation lifecycle
- flexCharge billing/reconciliation half

---

End of S435 handoff. **Destination-charge slice shipped
— 17 tests pinning the S113 PaymentIntent shape
(destination charges + platform safety valve), PM
company Transfer wrapper, and the ledger-driven
firing helper with idempotency + admin-notification
on Stripe failure.**

2311 tests / 133 files / 0 failures. Thirty-ninth
consecutive fully-green full-suite run.

**47 cumulative production bug fixes shipped across the
bug sweep.** Services audit: 42/43 services touched;
stripeConnect 10/12 functions covered, 2 remain for
S436 to close the arc.
