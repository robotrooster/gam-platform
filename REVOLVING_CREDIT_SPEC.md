# FlexCharge → Revolving Credit — build spec (S583, Nic-locked design)

Turns FlexCharge from a **deferred-debit charge account** (pay-in-full, no interest)
into a **revolving consumer-credit account** where the **MERCHANT (Business Account
Owner) is the lender** and GAM is the software vendor. Design fully locked S583;
the billing engine is a dedicated build (NOT yet written).

## Why / legal framing
- The MERCHANT extends revolving credit and sets the APR → the merchant is a
  **consumer lender under TILA / Reg Z** (APR + minimum-payment + billing-rights
  disclosures) and their state's lending/usury law. This is consistent with the
  existing FlexCharge model (CLAUDE.md: the Business Account Owner bears TILA /
  ECOA / FCRA / state-lending / usury / FDCPA obligations). GAM stays the vendor.
- **GAM never lends and never charges the borrower.** GAM's only take is a flat
  **1.5% / YEAR** software subscription on the balance, deducted from the
  merchant's payout. (Do not let GAM's cut touch the borrower — that's the
  structural firewall; see the S583 bug below.)
- **Rate cap: 6% / YEAR APR** (`FLEX_CHARGE_MAX_FINANCE_PCT = 0.06`). 6%/yr is
  under essentially every state usury cap (6%/*month* was the earlier mistake).
  Merchant is told to set a compliant APR; no state-specific logic in-platform.

## Locked decisions (S583, Nic)
1. **Revolving** — customers can pay part and carry the unpaid balance.
2. **GAM's cut = 1.5%/YEAR** on the balance (annualized ≈ 0.125%/mo), off the merchant.
3. **Minimum payment = greater of $25 or a % of balance** (constants, tunable — pick a % e.g. 3%).
4. **Grace period** — statement paid in full by the due date → **zero interest**;
   interest accrues only on a **carried** balance.
5. **Auto-pull default = the MINIMUM** (revolving by default); the customer can pay
   more (down to/including the full balance) to avoid or reduce interest.

## Monthly statement math (roll-forward)
```
new_balance = previous_balance
            + new_purchases (this cycle)
            + interest        (merchant APR/12 × average-daily-or-carried balance; $0 if prior statement paid in full by due date)
            + fees            (e.g. late fee if < minimum paid — decide separately)
            − payments_credited
minimum_due = max($25, MIN_PCT × new_balance)   (capped at new_balance)
```
GAM 1.5%/yr subscription accrues monthly (1.5%/12 × balance) and is **deducted from
the merchant payout**, not added to `new_balance`.

## What already exists (S583 — reuse, don't rebuild)
- `properties.flex_charge_finance_pct` — per-property APR (migration
  `20260805150000`), DB CHECK ≤ 0.06; `GET/PATCH /landlords/flex-charge/finance-rate(s)`;
  `FinanceRateSection` UI on landlord `FlexChargePage` (labeled ANNUAL APR).
- `flex_charge_statements.finance_charge` column (currently written as 0).
- **Fee-to-merchant fix is LIVE**: GAM's 1.5% is deducted from the merchant payout
  (`reconcileSettledFlexChargeStatement` + `supersedence.satisfyFlexChargeStatement`
  = `total_due − service_fee`) and the borrower is billed `total_due` only — never
  GAM's fee. This was the real S583 bug (GAM's 1.5% had been added to the borrower's
  statement). Keep.
- `FLEX_CHARGE_MAX_FINANCE_PCT` in `@gam/shared`.
- **The rate is NOT applied yet** — `generateMonthlyStatement` sets `finance_charge = 0`
  (FlexCharge stays pay-in-full until this engine lands). Scaffolding only.

## BUILD STATUS (S583)
**DONE + TESTED (158 green across 7 suites; API tsc clean):**
- Schema: `flex_charge_accounts.current_balance` (running balance) + statement roll-forward
  columns (`previous_balance`, `new_purchases`, `payments_credited`, `finance_charge`=interest,
  `late_fee`, `new_balance`, `minimum_due`, `amount_paid`). Migration `20260805160000`.
- Shared constants: `FLEX_CHARGE_MIN_PAYMENT_PCT=0.03`, `FLEX_CHARGE_MIN_PAYMENT_FLOOR=25`, `FLEX_CHARGE_LATE_FEE=10`.
- `generateMonthlyStatement` = the revolving roll-forward: interest = carried × APR/12 (grace is
  AUTOMATIC — carried 0 → 0 interest), late fee if the prior minimum wasn't met, minimum = max($25,3%),
  GAM 1.5%/12 off the merchant, resets the running balance. Method = **previous-balance** (interest on
  the unpaid carried balance; new purchases don't accrue until they carry → consumer-friendly, legal).
- `processFlexChargeStatementBilling` auto-pulls the **minimum**.
- `reconcileSettledFlexChargeStatement` credits the minimum to `amount_paid`, reduces the running
  balance, leaves purchases 'billed' (balance carries), pays the merchant (minimum − GAM's 1.5%/12).
- `supersedence.satisfyFlexChargeStatement` + FIFO list sweep the **minimum** (not full balance).
- Tests: first-statement / carry+interest / grace / late-fee / min-pull / reconciler-credit / merchant-payout.

**ALSO DONE + TESTED (S583, second pass — "finish those three pieces"):**
- **Customer pay-DOWN flow**: `payDownFlexCharge` + `reconcileFlexChargePaydown` (services/flexCharge.ts),
  route `POST /tenants/flexcharge/:accountId/pay`, webhook dispatch (gam_purpose=flexcharge_paydown), and
  the billing-cron guard (pull only the shortfall `minimum_due − amount_paid`; skip + mark 'paid' if the
  minimum's already covered → no double-charge). GAM's monthly cut is claimed exactly ONCE per statement
  via `gam_fee_settled` (atomic), whether the first dollar came from the auto-pull or a pay-down. Migration
  `20260805170000` + `20260805180000` (FCPAYDOWN entry_description, mirrored in shared).
- **Frontend statement display**: `listAccountStatements` returns the revolving fields; landlord
  `FlexChargePage` table = Purchases / Interest / New balance / Min due / Paid / GAM fee; tenant
  `FlexChargeAccountsCard` shows running balance + minimum + due date + a **pay-down modal** (minimum /
  pay-in-full / custom).
- **TILA disclosures**: customer-facing "how your account works" (APR set by merchant, interest only on
  carried balances, grace, minimum, $10 late fee, GAM fee never on the borrower) on the tenant card + POS
  onboarding; merchant-facing "you are the lender, comply with usury/lending law" on `FinanceRateSection`.

**STILL REMAINING (minor / non-blocking):**
- ✅ **Purchase-time credit-limit — FIXED S584.** `postFlexChargeTransaction` + `listFlexChargeAccounts`
  now gate/report on `current_balance` (carried, net of payments, incl. interest/fees) + open PENDING
  purchases — no longer the stale `SUM(pending,billed)` basis (which never fell as customers paid, so it
  permanently blocked a paid-off account and showed an ever-growing landlord balance). `FlexChargeAccountRow`
  gained `current_balance`. Regression + gate tests added in `flexCharge.test.ts` (33 green).
- POS-customer pay-down UI (the tenant route/service is generic; POS app needs its own button).
- Interest sub-method: **LOCKED S584 = previous-balance** (interest on the carried balance, grace
  automatic). Nic confirmed; NOT average-daily-balance. Already shipped — no change.
- **Dispute-under-revolving: LOCKED S584 = freeze the whole account.** One dispute disqualifies the
  account and stops all further billing; the merchant handles the Reg-Z billing-error directly. Current
  behavior stands (disputed amount stays in `current_balance`; account stops statementing). No change.
- Rest of the FlexCharge comb — ✅ **combed S584** (account create/limit/suspend/dispute, statement cron
  edges); all verified-good except the two design questions above.

## What the engine must build (original spec — see BUILD STATUS above for done/remaining)
1. **Partial payments** — the auto-pull takes the **minimum**, not `total_due`; the
   customer can pay more. Payment application + carried remainder.
2. **Carried balance** — the unpaid remainder becomes next cycle's `previous_balance`.
3. **Interest accrual** — merchant APR/12 on the carried balance, **with grace**
   (no interest if the prior statement was paid in full by the due date). Store as a
   `flex_charge_transactions` interest line or a statement field; `finance_charge`
   = the interest charged that cycle.
4. **Minimum payment** — `max($25, MIN_PCT × balance)`, surfaced on the statement +
   used as the auto-pull amount.
5. **Statement roll-forward** — previous balance + purchases + interest − payments
   (the math above). Likely new statement columns (previous_balance, interest,
   payments_credited, minimum_due, new_balance).
6. **GAM 1.5%/yr** — change `FLEX_CHARGE_STATEMENT_FEE_PCT` usage from per-statement
   1.5% to **1.5%/12 monthly** on the balance; still off the merchant payout.
7. **Customer pay-more UI** — tenant + POS-customer surfaces to pay down / pay in
   full (not just auto-min).
8. **TILA disclosures** — surface APR, minimum-payment terms, grace, billing-error
   rights (merchant's legal responsibility; platform presents them).
9. Update `services/flexCharge.ts`, `services/supersedence.ts`, `webhooks.ts`,
   statement schema, crons, and the FlexCharge tests.

## Open sub-decisions to confirm before building
- The MIN_PCT for the minimum payment (spec assumes ~3%).
- Interest basis: average-daily-balance vs previous/new statement balance.
- Late fee when the customer pays less than the minimum? (separate from interest.)
