# Session 254 — closed

## Theme

FlexCharge batch 3/3 — UI + POS payment-flow integration. Closes
the largest remaining v1 product. S252 built schema + engine, S253
built money-movement, this session closes everything else: monthly
statement-generation cron, POS charge-mode payment flow, POS UI
customer picker, tenant view, landlord dashboard.

## Defaults locked (no overrides)

- Statement generation: monthly cron on the 1st at noon Phoenix
- POS picker shows all merchant's tenants + pos_customers; account
  auto-scoped to POS's selected property
- NSF posture stays deferred-debit (merchant unpaid on NSF)

## Items shipped

### Statement generation cron — `services/flexCharge.ts` + scheduler

- `processFlexChargeStatementGeneration(now?)` walks every active
  FlexCharge account, calls `generateMonthlyStatement` for the
  previous cycle month. Idempotent via existing UNIQUE
  (account_id, cycle_month). Accounts with no pending tx skip
  cleanly (no statement row written).
- Cron registered at `0 12 1 * *` Phoenix (1st of month at noon).

### POS payment-flow integration — `routes/pos.ts`

POST `/api/pos/transactions` now accepts `posCustomerId` +
`propertyId` alongside the existing `tenantId`. When
`paymentMethod === 'charge'`:

1. `propertyId` required
2. Exactly one of `tenantId` / `posCustomerId` required
3. Every cart item must have a catalog id (no walk-up items) AND
   `pos_items.charge_eligible = TRUE`
4. `getAccountForCharge` lookup at (customer, property)
5. Account must be `'active'` and belong to caller's landlord
6. After `pos_transactions` insert + line items: call
   `postFlexChargeTransaction` to record against the account
   (gates on landlord disqualification + credit-limit + row lock)

`pos_transactions.pos_customer_id` column populated for non-tenant
charges. Existing cash/card flows unaffected.

### POS UI charge-mode picker — `apps/pos/src/pages/POSPage.tsx`

- New state: `chargeCustomerType ('tenant'|'pos_customer')`,
  `posCustomerId`
- New query: `/landlords/pos-customers` (enabled when `method === 'charge'`)
- Charge-mode UI now shows: property selector (auto-hidden for
  single-property landlords), customer-type toggle, customer
  picker (tenant select OR pos_customer select)
- `checkoutMut` body wires `tenantId` / `posCustomerId` / `propertyId`
  conditionally on charge mode
- Charge button disabled until (property selected AND customer
  selected AND no cart items missing chargeEligible)

### Tenant view — `apps/tenant/src/main.tsx` `FlexChargeAccountsCard`

New section on services page (auto-hides when no accounts):

- Lists every FlexCharge account the tenant holds (one per property
  they have a tab at)
- Per-account: property name, credit limit, **current balance**
  (highlighted gold), status badge
- Footer explaining the 1.5% monthly statement model + that disputes
  go through GAM support (in-product dispute flow exists at the
  backend but for v1 we route through support — keeps the
  "any dispute = permanent cutoff" decision behind a human review)

### Landlord dashboard — `apps/landlord/src/pages/FlexChargePage.tsx` (new)

`/flex-charge` route + 💳 FlexCharge nav entry. Layout:

- Property filter chips
- Accounts table: customer (name + email + tenant/pos_customer
  tag) / property / credit limit / balance / status / actions
- Actions: edit limit (prompt-based), suspend/reactivate
- `+ New Account` modal: customer-type toggle, customer picker,
  property + credit limit input (blank = property default)
- `+ POS Customer` modal: first/last/email/phone form posting to
  `/landlords/pos-customers`

## Decisions made during build

| Question | Decision |
|---|---|
| Statement generation cadence | Monthly cron 1st at noon Phoenix. Previous-month cycle aggregates everything; daily billing cron picks up due-today statements regardless of when they were generated. |
| Walk-up items chargeable to FlexCharge? | No. Must have a catalog id (no free-form prices) AND charge_eligible=true. Walk-up items are by definition not vetted; deferring debit on them is too loose. |
| Where lives the tenant FlexCharge view? | Services page section, auto-hides when no accounts. Avoids dedicated nav entry for the ~95% of tenants who'll never have a FlexCharge tab. |
| Dispute UX for tenants? | Route through GAM support for v1, not in-app self-serve. Permanent disqualification is heavy and benefits from human review. Backend route works; UI surface deferred. |
| pos_customer roster UI placement? | Modal on the FlexCharge dashboard. Avoids spinning up a separate POS-customers page when the typical flow is "I need a customer because I'm creating an account for them." |
| Landlord dashboard scope | Minimum-viable read-mostly. Statement history, dispute review, per-account transaction log all deferred to a polish session if Nic wants them. |

## Files touched (S254)

```
apps/api/src/services/flexCharge.ts                   (+ processFlex
                                                       ChargeStatement
                                                       Generation cron
                                                       entry; ~+50 lines)
apps/api/src/jobs/scheduler.ts                        (+ monthly gen
                                                       cron; ~+15 lines)
apps/api/src/routes/pos.ts                            (+ charge-mode gate
                                                       + posCustomerId
                                                       handling + post-
                                                       FlexChargeTransaction
                                                       call; ~+70 lines)
apps/pos/src/pages/POSPage.tsx                        (+ chargeCustomer
                                                       Type state +
                                                       pos_customers
                                                       query + extended
                                                       charge-picker UI
                                                       + checkoutMut
                                                       body extensions
                                                       + button gate;
                                                       ~+50 lines)
apps/tenant/src/main.tsx                              (+ FlexCharge
                                                       AccountsCard +
                                                       services-page
                                                       render; ~+60)
apps/landlord/src/pages/FlexChargePage.tsx            (new — ~280 lines)
apps/landlord/src/main.tsx                            (+ FlexChargePage
                                                       import + route)
apps/landlord/src/components/layout/Layout.tsx        (+ FlexCharge nav
                                                       entry)
DEFERRED.md                                           (~ FlexCharge entry
                                                       — fully closed)
SESSION_254_HANDOFF.md                                (this file)
```

## Verification

- `cd apps/api && npx tsc --noEmit` → clean
- `cd apps/landlord && npx tsc --noEmit` → clean
- `cd apps/tenant && npx tsc --noEmit` → clean
- `cd apps/admin && npx tsc --noEmit` → clean
- `cd apps/pos && npx tsc --noEmit` → clean

## End-to-end FlexCharge flow (now functional)

1. Landlord creates pos_customers + FlexCharge accounts via `/flex-charge`
2. POS cashier rings sale; picks paymentMethod='charge'; selects
   property + tenant/pos_customer
3. POST /pos/transactions gates on chargeEligible + account active
   + landlord not disqualified + within limit
4. Insert pos_transactions + line items + post flex_charge_transactions
   row against the account
5. Monthly cron (1st at noon Phoenix) generates statements for
   every active account with pending tx
6. Daily cron (8am Phoenix) ACH-pulls due statements
7. Webhook reconcile → flip statement to paid + Stripe Transfer
   to merchant Connect for balance (1.5% stays as GAM revenue)
8. If customer NSFs: 1st failure → NACHA retry; 2nd failure →
   statement failed + account suspended (deferred-debit posture;
   merchant unpaid)
9. If customer disputes: tx + account permanently disqualified;
   3-in-90-days landlord cutoff fires platform-wide
10. Tenant sees per-property balances on services page
11. Landlord manages accounts + customers via `/flex-charge`

## Carry-forward — S255+

### FlexCharge polish (post-launch)

- Statement history view on landlord dashboard
- Per-tx transaction log per account
- In-app dispute flow (currently support-routed)
- pos_customer ACH onboarding flow (currently they must register
  Stripe Customer + verify ACH out-of-band; need a tenant-portal-
  style onboarding for non-tenant FlexCharge users)
- Admin tooling for landlord-disqualification unblock

### Remaining v1 build queue

- **FlexDeposit follow-up**: deposit portability across leases,
  missed-installment legal remedy (Nic spec)

### Vendor-blocked

- **FlexCredit** — CredHub callback + Esusu email pending
- **Checkr Partner** — credentials pending

### Smaller items

- POS multi-terminal sync (premature)
- POS / `/resolve` smoke walks (Nic-runs)
- OTP cron-timing rework (non-blocking)

## Revised count

| Bucket | Pre-S254 | Post-S254 |
|---|---|---|
| FlexCharge | 1 session left (UI + POS integration) | **closed** |
| Multi-session epics in flight | 1 | 0 |
| v1 launch-ready FlexSuite | 3 of 4 (FlexPay, FlexDeposit, FlexCharge) | FlexCredit still vendor-pending |
| Remaining v1 sessions | ~2-3 | ~1-2 (FlexDeposit portability + Nic's pending specs) |

**Until v1 launch-ready:** ~1-2 sessions:
- FlexDeposit portability (bounded, can land any time)
- FlexCredit (when vendor responses arrive)
- Checkr Partner items (when credentials arrive)

---

End of S254 handoff.
