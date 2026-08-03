# SESSION 569 HANDOFF

**Continues the very long S568 session (read `SESSION_568_HANDOFF.md` first — it
covers retention audit, onboarding reconciliation, rent line-item split, financed
home sale, generic e-sign, and home-ownership tracking).** This handoff covers the
**bookkeeping / investor arc** built after that, plus the **bank-feed decision**.
Everything deployed to prod as we went; **all UNCOMMITTED.** Memory:
**[[gam-bookkeeping-pl-architecture]]**, **[[gam-mh-rv-sales-and-reconciliation]]**.

---

## Shipped after the 568 handoff (all deployed, tested)

### Investor-as-independent-operator (landlord-optional) — Nic strategic
- `properties.operator_owns_land` (FALSE = homes-only external park; toggle in
  PropertiesPage) + `units.lot_rent_amount` (AddUnitModal + live net).
- **Lot-rent economics:** `lot_rent_charges` ledger + daily accrual cron + record-
  paid (operator pays the external park OFF-platform, GAM moves no money) +
  `getInvestorPortfolio`. `/api/lot-rent/*`. **LotRentPage** ("Lot Rent & Net").
- An investor operates fully via the landlord portal without the park owner on GAM.

### Bookkeeping — the arc Nic pushed on
1. **Books is NOT an island (I was wrong first).** The landlord reports
   (`reports.ts` → ReportsPage) auto-book `payments` as income + expenses. The
   :3006 Books app (`books.ts`) is a SEPARATE surface (thin frontend, full backend).
2. **Income accuracy fix:** the monthly P&L was lumping deposits (a held liability)
   into income. Now categorized (rent / fees / utilities / home-sale), **deposits
   excluded**, platform/float fees excluded (GAM revenue).
3. **Landlord expense entry** (`landlord_expenses`) — unit-linked OR common;
   common can **allocate per unit** (for per-unit P&L). `/api/expenses`,
   **ExpensesPage**. Feeds the P&L.
4. **Detangle = one shared P&L** (`services/landlordPL.ts computeLandlordPL`) used
   by BOTH reports.ts AND books.ts, so they can't drift. Cash/settled_at basis.
   Expenses = platformFee + maintenance + lotRent + enteredExpenses.
5. **Bank reconciliation** (manual, `/api/bank-reconciliations` + **BankReconciliationPage**):
   log bank charges (category `bank_fees` → expenses → P&L), reconcile statement vs
   GAM-disbursed, difference. `difference` is a GENERATED column (don't insert it).
6. **Books portal (:3006) added to the launch set** (+ watchdog) and **admins
   REMOVED** from it (Nic: no admins in customer Books — GAM's own books are on the
   super-admin side). Books ALLOWED_ROLES = landlord/bookkeeper/business_owner/staff.
   Login copy fixed. Landlords reach it with the SAME login (verified live).

Test totals this arc: 331+ green across the touched suites (payments, leases,
homeSale, homeOwnership, lotRent, expenses, reports, books-reports, esign*, auth,
properties, units, bankReconciliation). Migrations `..210000`–`..240000` on prod.

---

## DECISION MADE — bank feed / auto bank-reconciliation
**Use Stripe Financial Connections (not Plaid).** Reasoning:
- Landlords already link a bank to Stripe for payouts → no second link, one vendor.
- FC published rate: **Transactions = 30¢ / institution / account holder / month**
  (flat subscription, not per-read). Balances (10¢/call) + Account Owners
  ($1.50/call) are SEPARATE opt-in products → **request only the `transactions`
  scope and they cost $0.** Verification is $1.50 (likely already paid at payout setup).
- **The signed Stripe agreement (`~/Downloads/Gold Asset Management - Stripe Pricing
  Agreement - May 6, 2026`) does NOT include Financial Connections** — it's cards
  (IC+ 0.70%+$0.26), ACH (0.5%/$3 cap, $4 fail), Connect ($0.20/payout, $1/mo active,
  0.17% volume), Link, Radar. So FC is at STANDARD rates; an amendment (§8) could
  negotiate lower, but 30¢/acct/mo is trivial vs the $10/property min. §2 requires
  Stripe be sole PAYMENT processor — FC is a data product, so fine either way.
- **NOT BUILT.** The core use case: a landlord spends $1k at Home Depot from THEIR
  bank (money that never touches GAM) → linked feed shows it → 2-click assign to
  a unit / "general property" / property-split-across-units (so per-unit/per-year
  maintenance articulates). GAM already knows GAM-passed money (rent/disbursements)
  — auto-match those, only surface bank-only items to categorize.

## Next session
- **Build the Stripe-FC bank feed** provider-agnostically: `bank_connections` +
  normalized `bank_transactions` (status matched/needs-review/categorized/ignored,
  links to the GAM payment/disbursement or the expense it became) → auto-match
  GAM-known deposits → click-to-categorize the rest (reuse the expense
  category + unit/common/allocate model) → reconciliation falls out. Live sync via
  FC + a CSV import fallback. (Nic wanted design reviewed before building — confirm
  the data-model/UX with him first.)
- Deferred (logged, not launch-blocking): GAM Books app UI build-out; align books.ts
  fully (only the GAM-income portion is shared today); one-click purchase-agreement
  from a financed sale; park-owner viral-loop upsell.
- Standing launch blockers unchanged: live Stripe cutover (C4/C5) + Oak Park data
  entry. Demo landlord james@demo.dev reconciliation window is CLOSED (extend
  `landlords.reconciliation_until` to demo feature #2 on demo data).
- Nic still wants the **landlord + tenant portal walkthrough** (he drives, fix live).

## State
All uncommitted — Nic decides the push. Context ran full at end of S568/569; work
is in a known-good, fully-deployed state.
