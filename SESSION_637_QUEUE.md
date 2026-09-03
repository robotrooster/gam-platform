# S637 — open work queue

Live tracker for this session. Nic: "I just need you to do it all so it doesn't
get forgotten." Update the status column as each lands; delete the file when the
last row is done and folded into a handoff.

## Status

| # | Item | State |
|---|------|-------|
| 1 | Leases: showed only Oak Park | ✅ done, committed, **not deployed** |
| 2 | Leases: property dropdown replaces search bar | ✅ done, committed, **not deployed** |
| 3 | GoldSign: needs-my-signature → in progress → completed ordering | ✅ done, committed, **not deployed** |
| 4 | Financials → Payments: owed / work-trade / history split | ✅ done, committed, **not deployed** |
| 5 | Expenses tab 400'd for a two-company account | ✅ done, committed, **not deployed** |
| 6 | Rent roll returned one entity's units | ✅ done, committed, **not deployed** |
| 7 | Flat-rate trash billed on the arrears sweep | ✅ code done, committed, **not deployed** |
| 8 | Dashboard "Tenants can't pay rent yet" banner | ✅ removed, committed, **not deployed** |
| 9 | Tenant-facing landlord-bank disclosure (2 endpoints + agent tool) | ✅ removed, committed, **not deployed** |
| 10 | Russ Fuller $37.60 carried-forward credit | ✅ applied in prod, credit sits on account |
| 11 | **Deploy everything above** | ⛔ BLOCKED — needs Nic's green light |
| 12 | **August trash cleanup** ($75 billed + $325 held) | ⛔ BLOCKED — run only AFTER #11 |
| 13 | **Financials: property filter on all 8 sub-tabs** | ⬜ TODO |
| 14 | **Disbursements: show who and where** | ⬜ TODO |
| 15 | **Credits must not split charges — ledger model** | ⬜ TODO |

---

## 11 — Deploy (blocked on Nic)

Standing rule: never deploy without his explicit go-ahead — two Claude windows
share this tree and `deploy.sh` ships the whole working tree, not HEAD.

Everything in rows 1–9 is committed and green but **not live**. Confirmed by
checking the built dist: the flat-rate fix is absent from what the API is
currently running.

## 12 — August trash cleanup (blocked on 11)

Script: `scratchpad/trash_cleanup.sql` — written, identifier-validated against
the live schema, **not executed**. Runs in a transaction and stops before
COMMIT so the numbers can be read first.

**Order matters.** Run it only after #11 ships. Until the flat-rate fix is live,
`generateBillsForProperty` can mint the same bogus August cycles straight back
into the rows the script just cleared — mopping with the tap on.

Removes: 3 August trash charges on live invoices ($75, of which $50 is actually
owed by anyone — Rhoades' is work-trade suspended) and 13 unreleased August
holds ($325). Leaves every September can, every metered charge, all rent.

## 13 — Property filter on every Financials sub-tab

Nic (DIRECTIVE): "All pages that view information for more than one property
need to be sortable by property."

Audited: **none of the eight** currently has one.

- `BalancesPage.tsx` — outstanding balances; payload already carries
  `propertyId`/`propertyName`
- `RentRollPage.tsx` — already groups by property; needs the dropdown to narrow
- `DisbursementsPage.tsx` — see #14
- `ReportsPage.tsx` — "reports by property"
- `ExpensesPage.tsx` — "expenses, selected property"
- `BankPage.tsx` / `BankingPage.tsx` — "bank account by property"
- `LotRentPage.tsx`

Reuse `PropertySelect` from `components/ListControls.tsx`. Note its built-in
behaviour: it hides itself below 2 options, which is what made the Leases filter
look missing when the API was only returning one property's rows. Verify each
page's payload actually carries a property before wiring the control.

## 14 — Disbursements: who and where

Nic: "disbursements page needs to show first to who and where." Currently
returns `[]` for his account, so the shape needs checking against a payload that
has rows before trusting the page.

## 15 — Credits are ledger entries, not charge surgery

Nic (DIRECTIVE): "Credits do not fucking split charges... It's a credit against
the overall ledger, not fucking settling partial payments. We don't do partial
payments." And on prepayment: a tenant handed a $500 bill who pays $1000 should
have "that surplus be credited on the account."

Two services do the same wrong thing:

- `services/creditApplication.ts` (`tenant_credits`)
- `services/prepaidRelease.ts` (`lease_prepaid_credits`)

Both walk open charges oldest-first, split the one the credit lands on, mark the
covered slice `settled`, and insert a `Remainder after…` row with
`is_remainder = true`. That IS a partial payment, which is banned platform-wide.

It also fabricates a settled charge with no money behind it, and
`routes/landlords.ts:768` counts `status='settled' AND type='rent'` with no
filter on whether cash moved — so a credit inflates Collected MTD on the
dashboard. (Two thousand lines down, `landlords.ts:5063` restricts the same idea
to "settled rent payments **with PI id**", so the codebase already knows the
distinction and applies it inconsistently.)

**Blast radius today: zero.** No `is_remainder` rows and no credit-settled
charges exist in production — the only one that ever existed was created and
reversed during this session. This is a fix before it bites, not a cleanup.

Target model: a credit never touches a charge. Amount due = charges − credit
balance. Charges settle whole or not at all. The credit draws down when money
actually moves. `user_balance_ledger` already has the right shape
(`type`, `amount`, `balance_after`, `reference_id`, `reference_type`).

`prepaidRelease.ts` also books the landlord's payout share
(`executeRentAllocation`), so it is load-bearing — it needs real tests, not a
quick edit.

---

## Also raised, Nic's own to-do (not code)

- **Mountain View RV Park Ranch LLC has no Stripe Connect**
  (`connect_payouts_enabled = false`). Rent there collects and sits on GAM's
  platform balance; nothing pays out until that entity's KYC is done. Nic:
  "I will work on that bank account thing tomorrow."
- **Fuller's credit date** — set to 2026-08-12 from "going on three weeks now."
  Confirm the real overpayment date and correct it if that's wrong.

## Two sources of truth for Connect readiness

`users.connect_payouts_enabled` is per ACCOUNT; `landlords.connect_*` is per
ENTITY. Nic's account reads false while Oak Park reads true. The money path
(`routes/payments.ts:389`) correctly uses the entity. The removed tenant-facing
endpoint used the account one. Nothing reads it wrongly today, but the split is
still there and will catch the next thing that touches it.
