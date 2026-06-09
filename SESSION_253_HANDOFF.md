# Session 253 — closed

## Theme

FlexCharge batch 2/3 — money-movement engine, dispute engine, and
landlord cutoff threshold. S252 shipped schema + service + routes;
this session adds the lifecycle hooks (statement billing cron,
webhook reconciles, NSF, disputes, threshold-driven landlord
disqualification, admin retry). S254 builds the UI surfaces + POS
payment-flow integration to complete the product.

## Product spec confirmed (Nic, this session)

| Question | Decision |
|---|---|
| Multi-dispute landlord cutoff threshold | **3 distinct disputers in rolling 90-day window** |
| Cutoff semantics | **Block new charges; existing open statements continue billing normally** |

## Default I flagged for review

**On final NSF, merchant doesn't get paid** (deferred-debit framing —
GAM doesn't front the merchant). If Nic wants GAM-eats-the-loss /
merchant-guaranteed-payout (like OTP/FlexPay's NSF model), I switch
in S254 by adding the merchant Transfer to the NSF handler too.

## Items shipped

### Schema migration — `20260511160000_flexcharge_landlord_disqualification.sql`

- `landlords.flex_charge_disqualified_until` timestamptz (NULL = OK)
- `landlords.flex_charge_disqualified_reason` text

Trigger: 3 distinct disputers (tenants OR pos_customers) against the
landlord with `disputed_at` within trailing 90 days. Cron-free —
threshold check runs at dispute time in `checkAndDisqualifyLandlord`.

### Service additions — `apps/api/src/services/flexCharge.ts`

| Export | Purpose |
|---|---|
| `processFlexChargeStatementBilling(now?)` | Daily cron entry. Walks `flex_charge_statements` where `status='open' AND due_date <= today AND payment_id IS NULL`. Resolves customer's Stripe customer + default payment method (tenant-keyed or pos_customer-keyed accounts both supported). Fires ACH `createRentPlatformCharge` for `total_due`. Creates `payments` row tagged `entry_description='SUBSCRIP'` + stamps statement `payment_id` + flips to `'billed'`. Failed statements get a `failed_reason` + admin alert with retry endpoint URL. |
| `markStatementFailed` *(internal)* | Helper for the failed-path branch. |
| `retryFlexChargeStatement(statementId)` | Admin retry. Resets `failed`-status statement to `open`, runs the cron pass inline. |
| `reconcileSettledFlexChargeStatement(paymentId)` | Webhook hook. Flips statement → `'paid'`, all linked transactions → `'paid'`, then fires `stripe.transfers.create` to landlord's user-level Connect for `balance` amount (1.5% fee stays on platform = GAM revenue). Idempotency key `flexcharge_payout_<statement_id>`. Landlord without Connect → admin alert; funds sit on platform balance pending Connect onboarding. |
| `handleFlexChargeStatementNsf(paymentId)` | Webhook hook for `payment_intent.payment_failed`. First failure (`retry_count<1`) defers to NACHA retry. Second failure flips statement → `'failed'` + account → `'suspended'`. No merchant payout. Admin alerted. |
| `disputeFlexChargeTransaction(args)` | Tenant or pos_customer disputes a transaction. Flips tx → `'disputed'`, account → `'disqualified'` (permanent, no cooldown). Returns whether the landlord-threshold check also fired. |
| `checkAndDisqualifyLandlord(landlordId)` | Counts distinct disputers in trailing 90 days; if ≥ 3, sets `landlords.flex_charge_disqualified_until = NOW() + 5 years` (effectively permanent; admin manually clears after review). Admin notification fires on threshold hit. |

### Account creation gate — `postFlexChargeTransaction`

- Now joins `landlords` to read `flex_charge_disqualified_until`
- New 409 when landlord disqualification window is active: "The merchant is currently blocked from offering FlexCharge"
- FOR UPDATE row lock stays on the account (S252)

### Scheduler — `apps/api/src/jobs/scheduler.ts`

New daily cron at 8am Phoenix:

```
'0 8 * * *' → processFlexChargeStatementBilling
```

Why daily, not monthly: statements get generated mid-cycle when
`generateMonthlyStatement` is called per account (S254 will wire
this on each POS charge close-out or by a separate cron). The
daily billing tick catches statements as their `due_date` arrives,
regardless of when the statement row was created. Daily granularity
also means a missed-by-one-day statement bills the next day instead
of waiting another month.

### Webhook integration — `apps/api/src/routes/webhooks.ts`

**`payment_intent.succeeded` handler:**
- After OTP / FlexPay / FlexDeposit / sublease reconcilers, calls
  `reconcileSettledFlexChargeStatement(row.id)`. Self-gating
  internal — no-ops on non-FLEXCHARGE-STMT payments.

**`payment_intent.payment_failed` handler:**
- After OTP / FlexPay / FlexDeposit NSF handlers, calls
  `handleFlexChargeStatementNsf(p.id)`. **Moved outside the
  `(rent|utility) + tenant_id` gate** because FlexCharge statement
  payments have `type='fee'` and can have NULL `tenant_id`
  (pos_customer accounts). Self-gating internal stays the
  no-op safety net.

### Tenant route — `apps/api/src/routes/tenants.ts`

- `POST /api/tenants/flexcharge/dispute/:txId` real implementation
  replaces the S252 501 stub. Validates `reason` (min 3 chars),
  delegates to `disputeFlexChargeTransaction` with
  `disputerTenantId = req.user.profileId`. Returns
  `{accountId, landlordId, landlordDisqualified}`.

### Admin route — `apps/api/src/routes/admin.ts`

- `POST /api/admin/flexcharge/statements/:id/retry-billing` —
  super_admin gated via existing `requireAdmin`. Calls
  `retryFlexChargeStatement` (resets `failed` → `open`, runs
  billing cron pass inline). Returns
  `{billed: boolean, reason: string}`.

## Decisions made during build

| Question | Decision |
|---|---|
| Merchant Transfer timing — at billing time or settlement? | At settlement (`payment_intent.succeeded` webhook). Pre-paying the merchant before ACH clears = float-lending risk; the deferred-debit framing requires customer-pays-first → merchant-paid-second. |
| Idempotency key for merchant Transfer | `flexcharge_payout_<statement_id>`. Re-firing on webhook re-delivery returns the original Transfer. |
| Landlord disqualification permanence | 5-year window stamp = effectively permanent; admin manually NULLs the field after review. Same pattern as tenant FlexDeposit disqualification but longer horizon (merchant-level decision deserves human review). |
| Statement billing — monthly or daily cron? | Daily. Statements have variable `due_date`; a missed daily tick recovers tomorrow vs a missed monthly tick recovers in 30 days. |
| FlexCharge NSF moved out of `if (p.type === 'rent')` block | pos_customer accounts produce payments rows with NULL tenant_id; the existing rent-gated handler block would skip them. Moved the call to a sibling block. |
| What happens to merchant share on NSF? | **Merchant doesn't get paid.** GAM doesn't have funds to forward (customer ACH failed) and doesn't front from reserves. Merchant is informed; can pursue customer directly. Tenant + account suspended. Flagged for Nic to override to GAM-eats-loss model if desired. |
| Dispute permanence | Permanent disqualification of the account; no cooldown. Per Nic spec: "any dispute = not flex charge". Admin manual unblock available if dispute later proves erroneous. |

## Files touched (S253)

```
apps/api/src/db/migrations/
  20260511160000_flexcharge_landlord_disqualification.sql  (new — 15 lines)
apps/api/src/db/schema.sql                                 (regenerated)
apps/api/src/services/flexCharge.ts                        (+ landlord
                                                            disqualification
                                                            check in
                                                            postFlexCharge-
                                                            Transaction;
                                                            + statement billing
                                                            + retry; + webhook
                                                            reconcilers; +
                                                            dispute engine +
                                                            landlord threshold;
                                                            ~+420 lines)
apps/api/src/jobs/scheduler.ts                             (+ daily 8am cron;
                                                            ~+15 lines)
apps/api/src/routes/webhooks.ts                            (+ settled hook +
                                                            NSF hook outside
                                                            rent gate; ~+25)
apps/api/src/routes/tenants.ts                             (~ dispute route
                                                            stub → real impl;
                                                            +15 / -10)
apps/api/src/routes/admin.ts                               (+ retry-billing
                                                            route; ~+10)
DEFERRED.md                                                (~ FlexCharge entry
                                                            updated — S253
                                                            shipped, S254
                                                            still UI + POS
                                                            integration)
SESSION_253_HANDOFF.md                                     (this file)
```

## Verification

- `cd apps/api && npx tsc --noEmit` → clean
- `cd apps/landlord && npx tsc --noEmit` → clean
- `cd apps/tenant && npx tsc --noEmit` → clean
- `cd apps/admin && npx tsc --noEmit` → clean
- Migration applied: `\d landlords` confirms `flex_charge_disqualified_until` + `_reason` columns

## End-to-end flow (excluding S254 UI + POS integration)

1. POS user creates a FlexCharge account for a customer at a property
2. (S254) POS sale with `payment_method='charge'` posts
   `flex_charge_transactions` row + decrements available credit
3. `generateMonthlyStatement` aggregates pending tx + 1.5% fee →
   `flex_charge_statements` row with `due_date` = 15th next month
4. **S253 daily cron** picks up due-today statements + fires ACH pull
   for `total_due` (balance + fee)
5. **S253 webhook reconcile** on success → flip statement to `paid`,
   flip txs to `paid`, fire merchant Transfer of `balance` to
   landlord Connect (1.5% stays on platform as GAM revenue)
6. **S253 NSF path** on 2nd ACH failure → flip statement `failed`,
   account `suspended`; admin alerted; merchant unpaid
7. **S253 dispute path** — customer disputes tx → account
   permanently disqualified; if 3 distinct disputers / 90 days
   against this landlord, landlord cut off platform-wide
8. **S253 admin retry** at `/api/admin/flexcharge/statements/:id/
   retry-billing` for stuck-failed statements

## Carry-forward — S254 (FlexCharge batch 3/3)

1. **Landlord FlexCharge dashboard.** Per-property list of accounts
   + balances + statements + manage actions (create account, edit
   limit, suspend, view statement history). Property settings:
   set `flex_charge_default_credit_limit`. Pos-customer roster
   management (create, archive).
2. **Tenant FlexCharge view.** Tenant-portal page displaying
   per-account balance + recent transactions + statement history
   + dispute button per transaction (with reason input). Account
   status visibility (active/suspended/disqualified).
3. **POS payment-flow integration.** When cashier selects
   `payment_method='charge'` at POS, gate on:
   - Tenant or pos_customer selected
   - Active account exists at this property
   - All cart items have `charge_eligible=true`
   - Cart total ≤ available credit (credit_limit − current_balance)
   - Landlord not disqualified
   On success, after `POST /pos/transactions` creates the row,
   immediately `postFlexChargeTransaction` to record the charge
   against the account.
4. **POS customer-picker UX.** Existing tenant selector + new
   pos_customer selector + "Add new customer" inline flow hitting
   `POST /landlords/pos-customers`.
5. **Statement generation cadence.** Decide whether to add a
   monthly cron that auto-runs `generateMonthlyStatement` on all
   active accounts on the 1st of each month, or fire on the last
   POS sale of the cycle, or expose as an admin action. Daily
   billing cron from S253 picks up whatever statements exist —
   the generator just needs a trigger.

## Other queue

### FlexDeposit follow-up

- Deposit portability across leases on GAM platform
- Missed-installment legal remedy (Nic pending spec)

### Vendor-blocked

- **FlexCredit** — CredHub callback + Esusu email pending
- **Checkr Partner** — credentials pending

## Revised count

| Bucket | Pre-S253 | Post-S253 |
|---|---|---|
| FlexCharge | 2 sessions left (S253 + S254) | 1 left (S254 UI + POS integration) |
| Multi-session epics in flight | 1 (FlexCharge 2/3) | 1 (FlexCharge 3/3) |
| Money-movement layers in v1 | All except FlexCharge | All including FlexCharge |

**Until v1 launch-ready:** ~2-3 sessions. S254 closes FlexCharge.
FlexDeposit portability is a clean one-session pick after. Vendor
unblocks (FlexCredit, Checkr) when responses arrive.

---

End of S253 handoff.
