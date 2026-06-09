# Session 189 — closed

## Theme

Tenant-facing deposit interest view. Closes the visible-to-tenant
loop on the S188 A3 deposit interest accrual engine. Tenants now
see their deposit principal + collected amount + accrued interest
+ per-month accrual history right on the Payments page.

## What S189 shipped

### Backend — `GET /api/tenants/me/deposit-interest`

Returns:

```ts
{
  deposit: {
    id, lease_id, total_amount, collected_amount,
    interest_accrued, status, held_by, state, property_name,
    created_at,
  } | null,
  rate: {
    state_code, effective_year, annual_rate_pct,
    statute_citation, notes,
  } | null,
  accruals: Array<{
    accrual_month, state_code, annual_rate_pct,
    principal_amount, days_held, interest_amount, created_at,
  }>
}
```

Three response shapes:
1. **No deposit** — `deposit: null` (tenant has no security_deposit row)
2. **Deposit + rate** — full data, including accrual history
3. **Deposit + no rate** — `rate: null` (state has no statutory
   requirement; tenant sees principal-only, no interest line)

`rate` lookup is keyed on `(state_code, current_year)`. State not
in the catalog → null → frontend renders the "no statutory
requirement" copy.

### Frontend — `SecurityDepositCard` on PaymentsPage

Renders below the saved-methods card, above the payments table.
Self-contained component with own `useQuery`. Hidden when no
deposit row.

Layout:
- Header: "Security deposit" label + property name
- Right side: total tenant pool ($collected + $interest) with
  "Total owed at move-out" caption
- Tile row: Required / Collected (green if fully funded, amber
  otherwise) / Interest accrued (only when rate exists)
- Helper copy: state-specific statute citation when rate exists,
  or "no statutory requirement" message when not
- Accrual history table: per-month rows with principal, days
  held, interest amount

### Files touched (S189)

```
apps/api/src/routes/tenants.ts                                          (+ GET /me/deposit-interest endpoint)
apps/tenant/src/pages/PaymentsPage.tsx                                  (+ <SecurityDepositCard /> placement + component definition + DepositTile helper + DepositInterestData type)
```

### Verification

- `cd apps/api && npx tsc --noEmit; echo $?` → 0
- `cd apps/tenant && npx tsc --noEmit; echo $?` → 0
- No schema migrations this session

## Decisions made (S189)

| Question | Decision |
|---|---|
| New tenant page (`/deposit`) or section on existing page? | Section on PaymentsPage. Adding a top-level nav entry for "Deposit" creates surface area for what's a relatively static read-only view. PaymentsPage is where tenants already go for money-related info; this is the natural home. |
| Show the card when tenant's state has no rate? | Yes, with a clear "no statutory requirement" message. Hiding the card entirely would leave tenants in non-statute states wondering where their deposit info lives. The card surfaces principal + collected amount even without interest. |
| Show accrual table when there's no history yet (deposit just funded)? | No — only render the table when `accruals.length > 0`. New deposits show the upper card with $0 interest until the first month-end accrual fires. |
| Project "next month's interest" estimate? | Deferred. Useful but adds math and the user can derive it from the rate + principal. Save for a refinement if Nic asks. |
| Tooltip on the statute citation linking to source? | Deferred. Citation text is plenty for now. Future improvement could parse the citation into a Cornell Law / state-government URL pattern. |

## Carry-forward — what S190+ should target

### Specific to A3 thread (still open)

- **Variable-rate state self-service (NY/NJ/CT/IL/PA/NH).** Per-bank
  or per-year rate that landlord enters annually. New
  `landlord_deposit_interest_rate_overrides` table + landlord UI.
  Half-to-full session.
- **Add more states to the hardcoded catalog.** Three-state starter
  is conservative. CA, IL Chicago RLTO, NV (none — no statute), RI,
  ND, etc. need research + INSERT migration.
- **Annual rate refresh discipline.** Document the cadence in
  CLAUDE.md or a dedicated DEPOSIT_INTEREST_PLAYBOOK.md so
  future-Claude knows to add 2027 rows in November/December.
- **Move-out interest payout** — currently the deposit-return engine
  adds interest to the refund pool. Need to also emit a credit-
  ledger event for the interest payment (separate from the
  principal refund) so the audit trail is clean. Half-session.

### Already-known carry-forward (still open)

- Primary manager urgency tier (S185 question)
- Owner-financial-escalation pattern (S186 question)
- pos_items.property_id schema (S183 carry)
- Sublease subsystem
- B1+B2 material-change workflow
- C1 50-state property tax form catalog
- B3 booking acknowledgment surface UI
- D2 Flex tenant suite (launch-flag gated)
- POS Terminal hardware + EOD
- CSV imports
- E2 npm upgrades
- F1 Marketing rebuild
- `leases.security_deposit` deprecation into `lease_fees`

---

End of S189 handoff.
