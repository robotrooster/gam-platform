# Session 248 — closed

## Theme

Closing the sublease product loop: sublessor credit-balance withdrawal
to bank account via Stripe Connect Transfer, plus an audit-and-fix of
the S247 money-routing path. Nic-confirmed (a) direct ACH to sublessor's
Connect (use case: pro sublessors managing 100s of mobile homes
through GAM); skip the credit-against-next-rent variant. Picked while
waiting on FlexCredit vendor callbacks.

## Items shipped

### Money-flow fix — `apps/api/src/routes/payments.ts`

**The S247 bug.** S247 redirected invoice + payment rows to sublessee
at `sub_monthly_amount` but did not adjust the destination-charge
math. Result: tenant pay route fired a destination charge with
`amount = sub_monthly_amount` and the existing
`computeApplicationFee(amount)` only deducted GAM's normal fee. The
landlord received `sub_monthly_amount - GAM_fee` — too much by the
markup amount. Sublessor markup never landed on platform balance; the
sublessor_credit_balances accrual in `subleaseAllocation.ts` was
crediting against money that didn't exist.

**The fix.** Inside the existing pay-route handler, look up whether
the payment is a rent payment whose payer is the sublessee on an
active sublease covering the cycle. When yes, compute
`subleaseMarkup = sub_monthly - master_share` and add it to
`applicationFeeAmount`. Stripe routes `(gross - app_fee)` to
landlord = `(sub_monthly - GAM_fee - markup) = (master_share -
GAM_fee)` ← what landlord actually expects. The markup lands on
platform balance and is then credited to the sublessor via the
existing webhook hook.

Added `p.due_date` to the pay route's payment-lookup SELECT (was
missing; needed for the sublease coverage check).

### Sublessor credit service — `apps/api/src/services/subleaseAllocation.ts`

| Export | Purpose |
|---|---|
| `getSublessorCredit(sublessorTenantId)` | Returns `{total_balance, total_earned, total_withdrawn, per_sublease[]}`. Powers the portal credit-card view. |
| `withdrawSublessorCredit({sublessorTenantId, amountDollars})` | Greedy drain across `sublessor_credit_balances` rows highest-balance-first, then single `stripe.transfers.create` to user's Connect account. Idempotency key includes timestamp + amount to avoid collision on repeated withdrawals. Throws 409 if Connect not onboarded, 409 if `connect_payouts_enabled=FALSE`, 400 if amount > balance. Decrements + Transfer fire in the same DB transaction — Transfer failure rolls back the balance decrements. |

### Routes — `apps/api/src/routes/subleases.ts` (2 new)

| Route | Verb | Purpose |
|---|---|---|
| `/api/subleases/me/credit` | GET | Sublessor-side balance view |
| `/api/subleases/me/credit/withdraw` | POST | Body `{ amount }`. Returns `{ stripeTransferId, withdrawnCents }`. |

Both gated on `req.user.role === 'tenant'`.

### Tenant UI — `apps/tenant/src/pages/LeasePage.tsx`

New `SublessorCreditCard` component shown below the existing
`SubleaseSection` on the lease page. Auto-hides when the tenant has
no sublease credit activity (no balance and no lifetime earnings).
When visible:
- Three-stat strip: available balance, lifetime earned, lifetime
  withdrawn
- Withdraw input + button — gated client-side on amount > 0 and
  amount ≤ balance
- Server-side errors surfaced inline; "Set up payouts" 409 includes
  a contact-support callout note since the embedded onboarding for
  tenants isn't yet wired (S249 follow-up)
- Expandable per-sublease breakdown when sublessor has 2+ active
  subleases

## Decisions made during build

| Question | Decision |
|---|---|
| Tenant Connect onboarding in S248? | **Deferred**. `@stripe/connect-js` and `@stripe/react-connect-js` aren't installed in `apps/tenant`. Adding npm packages mid-session has spillover risk; the credit balance + withdraw API is the harder half. UI shows a clear 409 "Set up payouts" message with a contact-support note when Connect isn't ready; S249 adds the packages + tenant-side BankingPage clone. |
| Withdrawal idempotency? | Stripe `Idempotency-Key: sublessor_withdraw_<tenantId>_<timestamp>_<amount>`. Distinct withdrawals always get distinct keys; a network-blip re-fire within the same request hits the same key and returns the original Transfer. Trade-off: doesn't dedupe across separate user clicks (intentional — those are distinct intents). |
| Withdraw greedy or proportional? | Greedy (drain highest-balance first). Proportional would distribute the withdrawal across all subleases by ratio, but greedy is simpler and the audit trail is just as clear via `total_withdrawn` per row. No product difference at the user level. |
| Decrement before or after Transfer? | Before, inside the same DB tx — Transfer failure rolls back the decrement via tx rollback. Avoids the "Transfer succeeded but DB didn't update" race. |
| Where to put the credit card UI? | LeasePage SubleaseSection's sibling — same vertical scope. Auto-hides when irrelevant so non-sublessor tenants never see it. |

## Files touched (S248)

```
apps/api/src/routes/payments.ts                  (~ +30 lines:
                                                  due_date column +
                                                  sublease markup
                                                  detection + app_fee
                                                  adjustment)
apps/api/src/services/subleaseAllocation.ts      (~ +210 lines:
                                                  getSublessorCredit +
                                                  withdrawSublessorCredit;
                                                  imports getStripe +
                                                  AppError)
apps/api/src/routes/subleases.ts                 (+ 2 routes: GET /me/credit,
                                                  POST /me/credit/withdraw;
                                                  ~+40 lines)
apps/tenant/src/pages/LeasePage.tsx              (+ SublessorCreditCard
                                                  component + fragment
                                                  wrap on lease section;
                                                  ~+155 lines)
DEFERRED.md                                      (~ sublease entry updated:
                                                  S248 closes withdrawal +
                                                  money-routing; flagged
                                                  tenant-Connect-onboarding
                                                  as next sublease follow-up)
SESSION_248_HANDOFF.md                           (this file)
```

No schema changes.

## Verification

- `cd apps/api && npx tsc --noEmit` → clean
- `cd apps/landlord && npx tsc --noEmit` → clean (unchanged)
- `cd apps/tenant && npx tsc --noEmit` → clean

## Carry-forward — S249+

### Sublease follow-ups

1. **Tenant-side Stripe Connect onboarding surface.** Add
   `@stripe/connect-js` + `@stripe/react-connect-js` packages to
   `apps/tenant/package.json`. Build a `/payouts` page mirroring
   the landlord `BankingPage` flow: `loadConnectAndInitialize` +
   `<ConnectAccountOnboarding />` calling
   `/api/stripe/connect/onboarding-session { entity: 'user' }`.
   The backend route already supports any user role — purely a
   frontend surface gap. Until shipped, sublessors can't withdraw
   (they hit the 409 "set up payouts" gate).
2. **Sublease document upload + e-sign**. Hook `services/esign.ts`
   so subleases can require both parties to sign a generated
   agreement before status='active'. Populates the dead
   `sublease_document_url` column.
3. **Admin sublease frontend.** Backend list query already supports
   admin/super_admin; just needs a `/subleases` page in apps/admin.
4. **Liability disclosure copy.** Tenant request modal should state
   "By submitting, you acknowledge you remain on the master lease
   and joint-and-severally liable for rent if your sublessee
   defaults." Landlord-configurable per state under no-state-legal-
   logic rule.

### Flex Suite remaining

- **FlexCredit** — vendor-pending (CredHub callback / Esusu email
  responses outstanding).
- **FlexCharge** — total rebuild (phantom tables; RV/extended-stay
  credit-account with POS integration). Multi-session.

### FlexDeposit follow-up

- Deposit portability across leases on GAM platform
- Missed-installment legal remedy

### External-vendor-blocked

- **Checkr Partner** — credentials still pending

## Revised count

| Bucket | Pre-S248 | Post-S248 |
|---|---|---|
| Sublease | 4 small follow-ups | 4 small follow-ups (withdrawal closed; tenant-Connect-onboarding is now the next one) |
| Sublease money-routing | latent bug | fixed |
| Flex products | 2 remaining (1 vendor-blocked, 1 multi-session) | same |

**Until v1 launch-ready:** ~4-5 sessions. Tenant Connect onboarding is
the shortest unblock for the sublease product line. FlexCharge is the
biggest remaining single-product scope. FlexCredit waits on vendor.

---

End of S248 handoff.
