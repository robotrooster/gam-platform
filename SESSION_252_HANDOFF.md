# Session 252 — closed

## Theme

FlexCharge full build — batch 1 of 3-session epic. Closes the
biggest remaining v1 product gap. This session lands the schema +
engine + replaces the long-broken phantom-table routes. Statement-
billing cron + dispute engine come in S253; tenant/landlord UI +
POS payment-flow integration in S254.

## Product spec confirmed (Nic, this session)

| Question | Decision |
|---|---|
| Fee model | **1.5% of statement balance** as a service fee, charged on the same ACH pull as the balance itself. No interest. No revolving balance. No per-tx markup. Auto-pay required → classes as deferred-debit not credit extension (out of payday-lending territory). |
| Credit limit | **Property-level default** set by POS user (landlord OR standalone POS operator); per-account override available. New accounts inherit the property default (`properties.flex_charge_default_credit_limit`, default $500). |
| Statement cadence | **Monthly statement**, balance + 1.5% fee, **auto-ACH-pulled** on the 15th of the next month. |
| POS items chargeable | **Only POS items where `pos_items.charge_eligible=true`**. Never platform fees, BG checks, deposits — those paths don't touch FlexCharge. |
| Audience | **Not property-type-gated**. Required: linked tenant OR pos_customer with ACH on file. |
| Dispute consequence | **Any dispute** (chargeback OR in-app) → tenant permanent disqualification. **Multi-dispute pattern** against same POS user → user-level cutoff (S253 engine). |
| Non-tenant customers | **Yes** — store merchants using GAM POS can set up known non-tenant customers via `pos_customers` table. |
| POS UI label collision | "FlexCharge fee" was actually the 1% card surcharge — unrelated to FlexCharge product. Renamed to "Card surcharge". |

## Items shipped

### Schema migration — `20260511150000_flexcharge_schema.sql`

- **`pos_customers`** — merchant-owned non-tenant customer roster.
  Fields: landlord_id, first/last name, email (UNIQUE per landlord
  via lowercase index), phone, stripe_customer_id, ach_verified,
  bank_last4, notes, archived_at (soft archive). 3 indexes.
- **`flex_charge_accounts`** — per (customer, property) tab. XOR
  CHECK on tenant_id / pos_customer_id. credit_limit, status
  enum (active/suspended/disqualified), disqualified_until,
  disqualified_reason. Two partial UNIQUE indexes: one per
  (tenant_id, property_id), one per (pos_customer_id, property_id).
  3 supporting indexes.
- **`flex_charge_transactions`** — per-charge log. account_id FK,
  pos_transaction_id FK, statement_id FK (backfilled later via FK
  added at end of migration), amount, status enum (pending/billed/
  paid/disputed/refunded), disputed_at + reason, refunded_at.
  4 indexes.
- **`flex_charge_statements`** — monthly cycle aggregation. UNIQUE
  (account_id, cycle_month). balance + service_fee + total_due,
  due_date, status enum (open/billed/paid/failed/voided),
  payment_id FK to payments. 2 indexes.
- **`pos_transactions.pos_customer_id`** column added (nullable FK).
- **`properties.flex_charge_default_credit_limit`** column (numeric,
  default $500.00).
- **`flexcharge_rollout_visible`** feature flag (default TRUE per
  S245 assessment posture).

### Shared package — `packages/shared/src/index.ts`

- `FLEX_CHARGE_STATEMENT_FEE_PCT = 0.015`
- `FLEX_CHARGE_DEFAULT_CREDIT_LIMIT = 500`
- Status enum constants + types: `FLEX_CHARGE_ACCOUNT_STATUSES`,
  `FLEX_CHARGE_TRANSACTION_STATUSES`, `FLEX_CHARGE_STATEMENT_STATUSES`

### Service — `apps/api/src/services/flexCharge.ts` (~420 lines)

| Export | Purpose |
|---|---|
| `isFlexChargeVisible()` | Wraps the feature flag |
| `createPosCustomer(args)` | Insert pos_customers row; 23505 → 409 friendly |
| `listPosCustomers(landlordId)` | Active customers for a merchant |
| `archivePosCustomer({landlordId, customerId})` | Soft-archive |
| `createFlexChargeAccount(args)` | XOR validation, property ownership check, tenant-on-active-lease OR pos_customer-belongs-to-landlord check, default credit limit from property if omitted |
| `listFlexChargeAccounts(args)` | List with customer name + email + computed balance per row |
| `updateFlexChargeAccount(args)` | Credit limit / status / notes; refuses 'disqualified' (engine-only) |
| `getAccountForCharge(args)` | Lookup at POS payment-flow time |
| `postFlexChargeTransaction(args)` | Posts a charge; gates on account=active + balance+amount ≤ credit_limit; FOR UPDATE row lock to avoid concurrent over-charge |
| `generateMonthlyStatement(args)` | Cycle aggregation: sums pending txs in window, applies 1.5% service fee, inserts statement row, flips included txs to billed with statement_id stamped, due_date = 15th of next month. Idempotent via UNIQUE (account_id, cycle_month). |
| `getFlexChargeAccountsForTenant(tenantId)` | Tenant-side view |

### Routes — `apps/api/src/routes/landlords.ts`

Replaced 4 phantom-table routes with real implementations:

| Old (phantom) | New (S252) |
|---|---|
| `GET /landlords/flexcharge` | `GET /landlords/flex-charge/accounts` |
| `POST /landlords/flexcharge` | `POST /landlords/flex-charge/accounts` |
| `DELETE /landlords/flexcharge/:tenantId` | `PATCH /landlords/flex-charge/accounts/:id` (status='suspended') |
| `PATCH /landlords/flexcharge/:tenantId` | `PATCH /landlords/flex-charge/accounts/:id` (creditLimit) |

Plus new POS customer routes:
- `GET /landlords/pos-customers` — list
- `POST /landlords/pos-customers` — create
- `DELETE /landlords/pos-customers/:id` — archive

### Routes — `apps/api/src/routes/tenants.ts`

- `GET /tenants/flexcharge` — returns `{visible, accounts: [...]}`, list
  shape replaces the prior one-account-per-tenant lookup that referenced
  phantom columns. Each account has property_name + balance.
- `POST /tenants/flexcharge/dispute/:txId` — returns 501 until S253 builds
  the disqualification engine. Pre-S252 route referenced
  `disqualified_at` (nonexistent column) and would crash on call;
  the 501 is the clean "not yet shipped" signal.

### Landlord UI — `apps/landlord/src/pages/TenantDetailPage.tsx`

- Legacy `FlexChargePanel` removed (it referenced phantom columns +
  hit the old route shape that assumed one account per tenant).
- FlexCharge tab now shows a "scoped per-property; see FlexCharge
  dashboard in S254" placeholder card.
- Unused state + imports (`useMutation`, `useQueryClient`, `apiPost`,
  `apiPatch`, `apiDelete`) pruned.

### POS UI rename — `apps/landlord/src/pages/POSPage.tsx` + `apps/pos/src/pages/POSPage.tsx`

- Receipt + cart line label "FlexCharge fee" → "Card surcharge"
- Label "FlexCharge (1%)" → "Card surcharge (1%)"
- Underlying column `pos_transactions.surcharge` unchanged (no
  migration needed; just the user-facing strings updated)

## Decisions made during build

| Question | Decision |
|---|---|
| Account uniqueness shape? | Per (customer, property), via two partial UNIQUE indexes (one for tenant-keyed, one for pos_customer-keyed). The XOR check on the columns means only one of the partial indexes ever sees a row per account. |
| `pos_customers` archive vs delete? | Soft archive (`archived_at` timestamp). Historical pos_transactions / flex_charge_accounts that reference an archived customer still resolve; the customer just stops appearing in active-roster queries. |
| Concurrent over-charge protection? | `FOR UPDATE` row lock on the account inside `postFlexChargeTransaction`'s transaction. Two simultaneous charges at the credit-limit boundary can't both pass the balance check. |
| Statement window? | Calendar month, aligned to `cycle_month` first-of-month date. Pending tx within `[cycle, cycle+1mo)` aggregate together. Strict calendar windowing keeps cycle math obvious for tenants reading the statement. |
| Due date? | 15th of the next month. 30-ish day window from cycle end keeps the deferred-debit framing clean. |
| `generateMonthlyStatement` on accounts with no pending tx? | Returns null, no row created. Cron will iterate every active account; the no-op skip is the natural path for accounts with zero monthly activity. |
| Phantom-route deprecation strategy? | Replaced GET / POST / DELETE / PATCH paths with real-table versions at new URLs. Old `/landlords/flexcharge*` paths are gone — any stale clients hit 404, which is correct (the old behavior crashed at runtime anyway). |

## Files touched (S252)

```
apps/api/src/db/migrations/
  20260511150000_flexcharge_schema.sql                (new — 175 lines)
apps/api/src/db/schema.sql                            (regenerated)
packages/shared/src/index.ts                          (+ 4 constants
                                                       + 3 status enums;
                                                       ~+15 lines)
apps/api/src/services/flexCharge.ts                   (new — ~420 lines)
apps/api/src/routes/landlords.ts                      (~ replaced 4
                                                       phantom routes
                                                       with 7 real
                                                       routes; ~+95 / -65)
apps/api/src/routes/tenants.ts                        (~ rewrote tenant
                                                       flexcharge routes;
                                                       dispute → 501;
                                                       ~+15 / -30)
apps/landlord/src/pages/TenantDetailPage.tsx          (~ deleted legacy
                                                       FlexChargePanel
                                                       + unused state +
                                                       unused imports;
                                                       ~+10 / -95)
apps/landlord/src/pages/POSPage.tsx                   (~ 2 label renames)
apps/pos/src/pages/POSPage.tsx                        (~ 2 label renames)
DEFERRED.md                                           (~ FlexCharge entry
                                                       expanded with S252
                                                       deliverables +
                                                       S253/S254 scope)
SESSION_252_HANDOFF.md                                (this file)
```

## Verification

- `cd apps/api && npx tsc --noEmit` → clean
- `cd apps/landlord && npx tsc --noEmit` → clean
- `cd apps/tenant && npx tsc --noEmit` → clean
- `cd apps/admin && npx tsc --noEmit` → clean
- `cd apps/pos && npx tsc --noEmit` → clean
- `packages/shared` rebuilt
- Migration applied: `\d flex_charge_accounts` confirms XOR check,
  status enum, partial UNIQUE indexes; `\d flex_charge_transactions`
  confirms statement_id FK + status enum; `\d flex_charge_statements`
  confirms cycle_month UNIQUE + status enum; `\d pos_customers`
  confirms email-per-landlord UNIQUE via function index;
  `\d pos_transactions` confirms pos_customer_id column;
  `\d properties` confirms flex_charge_default_credit_limit
- `flexcharge_rollout_visible = TRUE` seeded

## Carry-forward — S253 (FlexCharge batch 2/3)

1. **Statement billing cron**: monthly cron (15th at 6am Phoenix or
   similar) walks `flex_charge_statements` rows with status='open'
   where due_date <= today. For each: fire ACH-pull PaymentIntent
   for `total_due` to GAM platform balance (sublessee/tenant
   reimburses GAM for the merchant float + service fee). Inserts
   `payments` row tagged `entry_description='FLEXCHARGE_STMT'`,
   stamps `payment_id` on the statement, flips status to 'billed'.
2. **Webhook reconciliation**: on `payment_intent.succeeded` for
   a FLEXCHARGE_STMT payment, flip statement → 'paid', flip
   linked flex_charge_transactions to 'paid', settle the cycle.
   On `payment_intent.payment_failed`: ACH retry pipeline first;
   final failure → statement status='failed' + flex_charge_accounts
   status='suspended' + admin notification.
3. **Dispute engine**: `POST /api/tenants/flexcharge/dispute/:txId`
   real implementation. Tenant in-app dispute marks tx 'disputed',
   account 'disqualified' (no cooldown — permanent per Nic),
   admin notification. Webhook on Stripe chargeback dispute event
   triggers same path.
4. **Multi-dispute user cutoff**: count disputed transactions across
   all FlexCharge accounts under a given landlord_id; threshold
   (TBD — Nic input or default to 3 in a rolling 90-day window)
   flips a new `landlords.flex_charge_disqualified_until` field
   or similar to suspend the landlord's ability to offer FlexCharge
   at all.

## Carry-forward — S254 (FlexCharge batch 3/3)

1. **Landlord FlexCharge dashboard**: per-property list of accounts
   + balances + statements + manage actions (create account, edit
   limit, suspend, view statement history). Replaces the deleted
   per-tenant panel.
2. **Tenant FlexCharge view**: existing `/tenants/flexcharge` route
   returns the data; needs a tenant-portal page to display
   per-account balance + recent transactions + statement history.
3. **POS payment-flow integration**: when cashier selects
   `payment_method='charge'` at POS, gate on:
   - Tenant or pos_customer selected
   - Account exists at this property + status='active'
   - All cart items have `charge_eligible=true`
   - Cart total ≤ available credit (credit_limit − current_balance)
   On success, after `POST /pos/transactions` creates the row,
   immediately `postFlexChargeTransaction` to record the charge
   against the account.
4. **POS UI**: customer-picker for charge mode (existing tenant
   selector + new pos_customer selector + "Add new customer" inline
   flow that hits `POST /landlords/pos-customers`).

## Other queue

### FlexDeposit follow-up

- Deposit portability across leases on GAM platform
- Missed-installment legal remedy (Nic pending spec)

### Vendor-blocked

- **FlexCredit** — CredHub callback + Esusu email pending
- **Checkr Partner** — credentials pending

### Smaller

- POS multi-terminal sync (premature)
- POS / `/resolve` smoke walks (Nic-runs)
- OTP cron-timing rework (non-blocking)

## Revised count

| Bucket | Pre-S252 | Post-S252 |
|---|---|---|
| FlexCharge | Total rebuild required | Schema + engine + routes shipped; 2 sessions left (billing engine + UI) |
| v1 launch gap | FlexCharge + FlexDeposit portability + vendor unblocks | Same, but FlexCharge engine ready to run |
| Multi-session epics | 1 (FlexCharge) | 1 (FlexCharge, 2/3 batches left) |

**Until v1 launch-ready:** ~3-4 sessions: S253 + S254 (FlexCharge
billing + UI), FlexDeposit portability, then vendor-driven items
(FlexCredit, Checkr) when credentials/responses arrive.

---

End of S252 handoff.
