# Session 190 — closed

## Theme

Variable-rate state self-service for deposit interest. Closes the
remaining gap in the A3 thread: NY/NJ/CT/IL/PA/NH (and any other
state without a hardcoded statutory rate) need landlord-entered
rates because the platform can't know which bank the deposit lives
in. Schema + service fallback + landlord CRUD endpoints + Settings
page UI all shipped this session.

## What S190 shipped

### Schema — `landlord_deposit_interest_rate_overrides`

Migration `20260508140000_landlord_deposit_interest_overrides.sql`:

- New table keyed `(landlord_id, state_code, effective_year)`, with
  `annual_rate_pct numeric(6,4)` + free-text `source_notes`.
- CHECK constraints: 2-letter uppercase state, year in [2020,2100],
  rate in [0,100].
- Dropped the S188 FK from `security_deposit_interest_accruals` to
  `state_deposit_interest_rates` — accrual rows can now legitimately
  cite either source. The accrual row still snapshots state +
  effective_year + rate as columns; FK was defensive and is no
  longer reachable for override-sourced rates.

### Service — resolution priority + override fallback

`services/depositInterest.ts`:

- New `resolveRateForLandlord(landlordId, stateCode, year)` returns
  `{ source: 'statutory' | 'landlord_override', state_code,
  effective_year, annual_rate_pct }` or null.
- Resolution order:
  1. `state_deposit_interest_rates` (hardcoded statute) — wins if
     present
  2. `landlord_deposit_interest_rate_overrides` — fallback
  3. Skip accrual
- `computeMonthlyAccrual` calls the resolver instead of querying
  the statutory catalog directly.
- `runMonthlyAccrual` SELECT now pulls `l.landlord_id` so the
  resolver can scope the override lookup.

Statutory catalog wins because for fixed-rate states the rate IS
the statute; landlord can't override lower (legal exposure) and
"higher" doesn't apply (statute is floor + ceiling).

### Backend — three landlord endpoints

`routes/landlords.ts`, all owner-only via `requireLandlord`:

- `GET /api/landlords/me/deposit-interest-overrides` — list
- `PUT /api/landlords/me/deposit-interest-overrides` — upsert.
  zod-validated body `{ state_code, effective_year,
  annual_rate_pct, source_notes? }`. Refuses (409) when a statutory
  catalog entry exists for the same (state, year) — overrides
  can't replace hardcoded rates.
- `DELETE /api/landlords/me/deposit-interest-overrides/:state/:year`

### Tenant endpoint — fall through to override

`GET /api/tenants/me/deposit-interest` now returns the override
rate when there's no statutory entry, with `rate.source` indicating
which catalog the rate came from. Frontend differentiates copy:

- `source='statutory'`: "MA requires 5.00% annual interest per
  Mass. Gen. Laws Ch. 186 § 15B(2)(a)..."
- `source='landlord_override'`: "Your landlord has set a 1.50%
  annual interest rate for NY deposits (2026)..."

### Frontend — `DepositInterestOverridesCard` on SettingsPage

New card on `/settings`. Renders existing overrides as a small
table with delete buttons; "Add override" opens an inline form
with state/year/rate/notes fields. State-specific hint copy when
the user enters a known variable-rate state (NY/NJ/CT/IL/PA/NH)
to nudge them on where to find the right rate (bank passbook
lookup, state Banking Commissioner publication, etc.).

Hints embedded:
- NY: bank passbook rate (RPL § 7-103)
- NJ: bank rate minus 1% admin fee (NJSA § 46:8-19)
- CT: state-published rate, updated annually by Banking Commissioner
- IL: actual interest earned (or higher of statutory minimum)
- PA: bank passbook rate, escrow account required for ≥ $100
- NH: rate held in escrow (must equal at least bank-paid rate)

### Files touched (S190)

```
apps/api/src/db/migrations/20260508140000_landlord_deposit_interest_overrides.sql  (NEW)
apps/api/src/db/schema.sql                                              (regenerated)
apps/api/src/services/depositInterest.ts                                (resolveRateForLandlord helper; computeMonthlyAccrual + runMonthlyAccrual SQL pull landlord_id)
apps/api/src/routes/landlords.ts                                        (+ GET/PUT/DELETE deposit-interest-overrides + zod schema)
apps/api/src/routes/tenants.ts                                          (/me/deposit-interest falls through to override; rate.source field)
apps/landlord/src/pages/SettingsPage.tsx                                (+ DepositInterestOverridesCard component + apiPut/apiDelete imports + Trash2 icon)
apps/tenant/src/pages/PaymentsPage.tsx                                  (rate.source branching in helper copy; type signature includes source field)
```

### Verification

- `npm run db:migrate` → 1 applied; schema.sql regenerated
- `cd apps/api && npx tsc --noEmit` → 0
- `cd apps/landlord && npx tsc --noEmit` → 0
- `cd apps/tenant && npx tsc --noEmit` → 0

## Decisions made (S190)

| Question | Decision |
|---|---|
| Allow override for hardcoded states (e.g. landlord wants to pay MA tenants more than 5%)? | No — refuse with 409. Statutory catalog wins; the override path only fires when statutory is absent. Allowing override-on-statutory would invite confusion and let landlords lower the rate (legal exposure). Higher-than-statute is a separate "lease-specific generosity" model out of scope. |
| Drop the FK from accruals to state_deposit_interest_rates? | Yes. Accrual rows can legitimately come from either catalog now. The accrual row still records state_code + effective_year + rate as columns (snapshot at write time); FK enforcement was defensive and incompatible with the override path. |
| Store hint copy in DB or hardcode in frontend? | Frontend hardcoded in `VARIABLE_STATE_HINTS`. Hints are guidance, not data — they don't drive backend behavior. Adding a DB table for hints would create a third source of truth (statute, override, hint) for marginal benefit. |
| Validate state-code allow-list (only specific variable-rate states)? | No. Schema CHECK enforces 2-letter uppercase, format only. Some states have no statutory requirement at all but a landlord may want to pay interest as a tenant-friendly choice; we don't gatekeep. The hint copy nudges toward the known variable-rate states. |
| Per-year history vs current-year only? | Per-year. Landlord enters a rate for a specific (state, year); next year they enter a new row. Matches the statutory catalog pattern (annual-refresh) so accrual queries stay symmetric. |
| 409 on statutory collision vs silently-ignore-override? | 409. Silent ignore would mean a landlord enters an MA override and sees no effect — confusing. Loud refusal at write time is cleaner. |

## Carry-forward — what S191+ should target

### Specific to A3 thread

- **Move-out interest payout credit-ledger event.** Deposit return
  finalize emits ledger events for principal refund / gap; need a
  separate event for the interest portion so the audit trail is
  clean. Half-session.
- **Expand hardcoded state catalog.** The 3-state starter (MA/MD/MN)
  is conservative. Research + INSERT migration for additional
  fixed-rate states (e.g., RI 2.5%, IA 1%, ND 0%-but-mandatory).
  Multi-hour task.
- **Annual rate refresh discipline.** Document the cadence (when
  2027 rolls around, a new migration extends both catalogs).
  Should live in CLAUDE.md or a dedicated playbook.
- **Tenant-facing override visibility on lease signing.** When a
  tenant signs a lease in a variable-rate state, surface the
  current override rate so they know up-front what interest will
  accrue. Half-session.

### Already-known carry-forward (unchanged)

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

End of S190 handoff.
