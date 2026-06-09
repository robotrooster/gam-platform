# Session 261 — closed (Session B of FlexDeposit legal-remedy build)

## Theme

GAM-supersedence routing engine. Every successful tenant ACH pull
now routes through GAM first to satisfy outstanding GAM-owed debts
(FlexDeposit defaults / accelerated balance / FlexCharge balances /
FlexPay fees / custody fees), oldest-first; surplus to landlord;
landlord's lease ledger shows rent paid in full. Implements the
load-bearing rule from `project_gam_supersedence_routing.md` memory.

## Scope-shaping confirmed pre-build

| Q | Locked direction |
|---|---|
| Boost mechanism | (Q1a) Increase `application_fee_amount` at PI creation. Same Stripe call routes the boost to GAM at charge time; mirrors the existing `passthroughAmount + subleaseMarkup` pattern in payments.ts. |
| PM-company fee priority | (Q2a) PM cut computes on **gross** (contractually owed); supersedence reduces owner share, not PM share. |
| FIFO ordering | (Q3a) Single global FIFO by oldest unpaid date ASC across all 5 sources. Ties broken deterministically by source name then ref_id. |
| FlexCharge gating on FlexDeposit-in-flight | (Q3 add-on, version i) Any active plan blocks enrollment — not just defaults/accelerated. Matches qualification gate order. |
| Scope of boost | (Q4c) All payment types, including the GAM-product pulls themselves. The FlexDeposit↔FlexCharge collision case is precluded by the gating rule. |

## Items shipped

### Migration — `20260513100000_payments_gam_supersedence.sql`

Three new columns on `payments`:

- `gam_supersedence_amount NUMERIC(10,2) NOT NULL DEFAULT 0` — dollars
  redirected to satisfy older GAM debts (boost captured at PI creation).
- `gam_supersedence_breakdown JSONB` — ordered FIFO list of which
  debts were satisfied: `[{source, ref_id, amount, satisfied_at}, ...]`.
  NULL until applyTenantSupersedence runs on webhook settle.
- `gam_supersedence_applied_at TIMESTAMPTZ` — idempotency stamp.

`payments_gam_supersedence_amount_nonneg` CHECK enforces the floor.
No backfill needed — defaults handle pre-S261 payments cleanly.

### New service — `apps/api/src/services/supersedence.ts`

Two exported entry points + one helper:

- `computeTenantGamOutstanding(tenantId, client?)` → ordered FIFO
  `OutstandingItem[]` across the 5 sources:
  1. `flex_deposit_installments` status='defaulted' on plans active|in_default
  2. `security_deposits` flex_deposit_plan_status='accelerated'
     (`balance_due_total`)
  3. `flex_charge_statements` status IN ('open','failed') AND due_date<=today
     (tenant-linked accounts only — POS-customer accounts excluded)
  4. `flexpay_advances` status='defaulted'
  5. `flex_deposit_custody_charges` status='failed'

- `computeTenantGamOutstandingTotal(tenantId, client?)` → scalar dollar
  sum used by PI-creation paths to size the boost.

- `applyTenantSupersedence(client, paymentId)` → reads
  `payments.gam_supersedence_amount` captured at PI creation,
  walks the live FIFO list, marks rows satisfied in order until boost
  exhausted. Idempotent via `gam_supersedence_applied_at`. Returns
  `{applied, amount_distributed, amount_residual, post_commit_transfers}`.
  Per-source satisfiers:
  - FlexDeposit installment → status='settled', security_deposits
    counters bumped, fund-status flip if all installments paid.
  - FlexDeposit acceleration → mirrors `settleFlexDepositAcceleration`
    (plan→'completed', mass-settle remaining installments).
  - FlexCharge statement → status='paid', transactions paid, returns
    a `PostCommitTransfer` so the webhook can fire the landlord
    merchant Transfer (balance only; 1.5% service_fee stays on
    platform as GAM revenue).
  - FlexPay advance → status='reconciled'.
  - Custody charge → status='settled'.

Race-safety: each satisfier uses `UPDATE ... WHERE status = <expected>`
so a concurrent satisfaction returns 0 rowCount and the FIFO walker
skips. Over-collection (boost > live FIFO total at settle) is
recorded in `breakdown[].residual=true` and admin-flagged.

### PI-creation wiring (5 paths)

All paths compute boost = `min(amount, computeTenantGamOutstandingTotal)`
and bake it into the PI amount (platform-only charges) or
`application_fee_amount` (destination charges). Boost stamped on the
created `payments` row.

- `apps/api/src/routes/payments.ts /pay` — boost added to
  `applicationFeeAmount` alongside the existing passthrough +
  subleaseMarkup deltas. Stamped on payments row at status flip.
- `apps/api/src/services/flexDeposit.ts processFlexDepositInstallmentDue`
  — pull amount = installment + boost. Installment row in
  status='pending' is excluded from FIFO by source's status filter.
- `apps/api/src/services/flexDeposit.ts accelerateFlexDepositPlan` —
  pull amount = remaining + boost; subtracts `remaining` from
  outstanding-total to avoid double-counting (the just-stamped
  accelerated balance is in the FIFO list).
- `apps/api/src/services/flexDeposit.ts processFlexDepositCustodyFees`
  — pull amount = $CUSTODY_FEE + boost. Just-inserted custody row is
  status='pending', not in FIFO.
- `apps/api/src/services/flexCharge.ts processFlexChargeStatementBilling`
  — pull amount = total_due + boost; subtracts total_due to avoid
  self-counting. POS-customer accounts (no tenant_id) get boost=0.
- `apps/api/src/services/flexpay.ts processFlexPayPullDay` — pull
  amount = (rent + fee) + boost. Advance is in 'fronted' status, not
  in FIFO; no self-subtract needed.

### Webhook wiring — `apps/api/src/routes/webhooks.ts`

Inside the existing `payment_intent.succeeded` transaction, after all
other reconcilers run for each settled row, `applyTenantSupersedence`
distributes the boost FIFO. Captured `post_commit_transfers` +
`residual` per row are queued for post-commit firing.

Post-commit block (after the existing PM + manager Transfer fan-out):

- For each `PostCommitTransfer` with source='flexcharge_statement':
  fires `stripe.transfers.create` for `balance` to the landlord's
  Connect account, idempotency-keyed `flexcharge_payout_super_<stmtId>`.
  If the landlord has no Connect account yet, admin-notify
  `flexcharge_merchant_transfer_pending`. On Stripe error,
  admin-notify `flexcharge_merchant_transfer_failed_supersedence`.
- If `residual > $0.005` (boost exceeded live FIFO total at settle —
  debts shrunk between PI create and webhook, or concurrent
  satisfaction), admin-notify `supersedence_residual_unallocated`
  with the over-collected dollar amount. Funds stay on platform
  balance pending review.

### Allocation engine — `apps/api/src/services/allocation.ts`

`fetchPayment` now selects `gam_supersedence_amount` alongside the
existing columns. `executeRentAllocation` subtracts the supersedence
from `ownerShare` BEFORE the user-balance ledger write:

```
ownerShare = splittable − managerFee − pmCompanyFee − supersedenceAmount
```

PM company fee + manager fee still compute off the full `splittable`
(Q2a — they're contractually owed against the gross rent the tenant
paid; the supersedence reduces only the owner's slice). If the math
goes negative (high PM percent + supersedence on thin-margin
property), the allocation throws 409; Stripe will retry the webhook,
and admin sees the failure via the existing
`webhook_payment_settled_handler_failed` critical alert.

The `gam_supersedence_amount` column is the audit trail for the
"missing" portion of owner_share — landlord dashboards can join
`payments.gam_supersedence_amount` against
`user_balance_ledger WHERE reference_id = payment.id` to display
"Rent paid: $X / Net to bank: $Y" (Session C surface).

### FlexCharge enrollment gating — `apps/api/src/services/flexCharge.ts`

`createFlexChargeAccount` for a tenant-linked account now refuses
when the tenant has any `security_deposits` row with
`flex_deposit_enabled=TRUE` AND `flex_deposit_plan_status IN
('active','accelerated')`. Error: 409 with the deposit id + plan
status spelled out. POS-customer accounts (no tenant context) skip
this gate.

## Decisions made during build

| Question | Decision |
|---|---|
| Should partial-satisfaction be supported (boost covers part of an item)? | **No** for v1. If the live boost can't fully cover the next FIFO item, the leftover is recorded as `residual=true` in the breakdown and admin-flagged. Avoids reasoning about "FlexCharge statement is 30% paid" semantics. Race-safety + idempotency stay cleaner. |
| For FlexCharge statement supersedence, does the merchant Transfer fire on the FULL total_due or only the BALANCE? | **Balance only.** The 1.5% `service_fee` stays on platform balance as GAM revenue — same posture as `reconcileSettledFlexChargeStatement`. The Transfer description includes "(supersedence)" so the merchant audit clearly distinguishes from a direct customer-pay settlement. |
| Should the supersedence boost itself appear in `platform_revenue_ledger`? | **No.** The boost isn't revenue — it's GAM collecting on existing receivables. Downstream side-effects (e.g., the FlexCharge service_fee staying on platform when the balance pays out via supersedence) are tracked by their own existing mechanisms. The `breakdown` JSONB on the payment IS the audit trail. |
| FlexCharge gating granularity — block on any active plan, or only on defaulted/accelerated? | **Any active plan.** Matches the qualification gate order in CLAUDE.md (bg → deposit → ACH → OTP → FlexCharge at tail). Cleaner mutual-exclusion rule for the FIFO logic. |
| Boost call signature — pass tenant_id + amount, or look up payment context internally? | Pass tenant_id + amount externally. Each PI-creation path already has both in hand and wants distinct boost-vs-base accounting in its INSERT. Avoids round-tripping the payments row before the row exists. |
| Negative owner_share guard — clamp to 0 or throw? | **Throw 409.** Stripe retries the webhook automatically; admin gets the failure alert. Clamping would silently lose accounting and require manual reconciliation. |

## Files touched (S261)

```
apps/api/src/db/migrations/
  20260513100000_payments_gam_supersedence.sql        (new — ~25 lines)
apps/api/src/db/schema.sql                            (regenerated)
apps/api/src/services/supersedence.ts                 (new — ~395 lines)
apps/api/src/services/flexDeposit.ts                  (~ installment +
                                                       acceleration +
                                                       custody pulls
                                                       boosted; ~+30)
apps/api/src/services/flexCharge.ts                   (~ statement pull
                                                       boosted; enroll
                                                       gating on FlexDeposit
                                                       active; ~+40)
apps/api/src/services/flexpay.ts                      (~ pull boosted; ~+12)
apps/api/src/services/allocation.ts                   (~ PaymentRow column
                                                       added; owner_share
                                                       subtracts
                                                       supersedence;
                                                       negative-guard
                                                       409; ~+18)
apps/api/src/routes/payments.ts                       (~ /pay computes +
                                                       bakes boost into
                                                       application_fee_amount;
                                                       stamps payments row;
                                                       ~+16)
apps/api/src/routes/webhooks.ts                       (~ applyTenant
                                                       Supersedence inside
                                                       settle tx; post-
                                                       commit FlexCharge
                                                       merchant Transfers
                                                       + residual admin-
                                                       notify; ~+85)
DEFERRED.md                                           (~ FlexDeposit entry
                                                       Session B tombstoned;
                                                       Session C remaining)
SESSION_261_HANDOFF.md                                (this file)
```

## Verification

- `npm run db:migrate` → 1 applied; schema.sql regenerated to 11443 lines
- `cd apps/api && npx tsc --noEmit` → clean
- `cd packages/shared && npx tsc --noEmit` → clean
- `psql gam -c "\d payments"` → 3 new columns + CHECK constraint visible

## Carry-forward — S262+

### Session C (next) — UI surfaces + lease-end settlement

The locked Session C scope from S259/S260, unchanged:

1. **Tenant LeasePage** — "Balance due in full" surface when plan
   status='accelerated'. Shows `balance_due_total` + one-tap-pay
   button. Renders only while accelerated (pre acceleration pull).
2. **Landlord dashboard payment view** — two-number display where
   supersedence applied: "Rent paid: $X" (gross / lease status) +
   "Net to bank: $Y" (actual disbursement to Connect). No mention
   of WHICH GAM product superseded. Data source:
   `payments.amount` − `payments.gam_supersedence_amount` (or for
   destination charges, the `allocation_owner_share` ledger entry
   directly).
3. **Lease-end deposit-return engine** — read `collected_amount`
   vs `total_amount` on `security_deposits`; GAM eats the gap (if
   any); landlord gets a single Transfer for the collected portion
   at termination.

### Vendor-blocked (unchanged)

- Checkr Partner credentials pending
- FlexCredit (CredHub + Esusu) pending

### Other deferred (unchanged from S259/S260)

- POS multi-terminal session sync — Nic-approved scope, needs
  scope-shaping session before code lands

## Revised count

| Bucket | Pre-S261 | Post-S261 |
|---|---|---|
| FlexDeposit remedy backend (schema + acceleration) | Session A shipped S260 | unchanged |
| FlexDeposit supersedence routing | open | **Session B shipped** |
| FlexDeposit UI + lease-end settlement | open | Session C remaining |
| POS multi-terminal sync | needs scope-shaping | unchanged |
| Vendor-blocked | 2 | 2 |

---

End of S261 handoff.
