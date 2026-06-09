# Session 65 Handoff

**Theme:** 16a Step 3 — pivot bank-account architecture from per-user-primary to per-property assignment. Migrations only. Code patches deferred to S66 (first Claude Code session).

## Architectural decision

S64 shipped `user_bank_accounts` with `is_primary` + a partial unique index, assuming one primary account per user. The actual product model is per-property:

- `user_bank_accounts` is a per-user catalog (user adds, user manages, 1099s point at)
- Each property points at one bank account via `property_allocation_rules.owner_bank_account_id`
- Multiple properties can share one bank account (several properties under one LLC)
- Per-user "primary" is meaningless under this model
- Manager fees route through a single per-user default (`users.default_management_payout_bank_account_id`) — not per-property
- `user_balance_ledger.bank_account_id` is a snapshot tag set at allocation time; autoPayouts will GROUP BY (user_id, bank_account_id) on Friday

This minimizes disbursements: properties pointing at the same LLC bank collapse into a single ACH on Friday. Owners with multiple LLCs get separate disbursements per LLC.

Snapshot semantics (not lookup-at-payout-time): if a landlord re-points a property to a new bank later, already-allocated funds stay routed to the bank that was configured at the moment of allocation.

## Shipped — migrations only

### Migrations (4)

1. `20260503000000_user_bank_accounts_pivot_to_per_property.sql`
   - DROP partial unique index `ux_user_bank_accounts_primary`
   - DROP COLUMN `is_primary`
   - ADD COLUMN `account_holder_type` NOT NULL DEFAULT 'individual', CHECK ('individual','business')

2. `20260503000100_property_allocation_rules_bank_account.sql`
   - ADD COLUMN `owner_bank_account_id` UUID NULL FK → user_bank_accounts(id)
   - Partial index on the column WHERE NOT NULL

3. `20260503000200_users_default_management_bank.sql`
   - ADD COLUMN `default_management_payout_bank_account_id` UUID NULL FK → user_bank_accounts(id)
   - Partial index on the column WHERE NOT NULL

4. `20260503000300_user_balance_ledger_bank_account_snapshot.sql`
   - ADD COLUMN `bank_account_id` UUID NULL FK → user_bank_accounts(id)
   - Partial index on the column WHERE NOT NULL
   - Existing `ux_user_balance_ledger_idempotent` unaffected (keys on reference_id/reference_type/type)

schema.sql snapshot: 5752 → 5784 lines.

## Decisions made this session (locked, no code yet)

- **Multi-account model:** users can hold multiple accounts (one per LLC); no per-user primary; account is selected per-property.
- **Account/routing immutable:** edit only `nickname` + status. Number change = add new + archive old.
- **No hard delete:** soft only via `status = 'archived'`. Row + encrypted number persist forever for GAM audit.
- **super_admin scope:** read-only. Can list any user's accounts and trigger a decrypt-and-reveal flow (audit-logged via existing `audit_log` table). No edit, no archive, no delete.
- **Manager-fee routing:** per-user default (`users.default_management_payout_bank_account_id`), not per-property. Manager UI deferred — column gets configured via super_admin tooling or DB until a managers' settings surface lands.
- **Verification:** zero verification in S65 beyond 9-digit ABA checksum. Micro-deposits deferred until after Stripe wiring (Nic's Stripe work, days out).
- **`balance_after` semantics:** stays as user-wide running total. Per-bank totals computed at payout time via grouped SUM. No backfill of existing dev rows.
- **UI placement:** Banking is a top-level sidebar item in the landlord portal (its own route `/banking`), not a Settings sub-tab.
- **Card payment methods:** stayed collapsed to single `card` per S64.

## Standing-rule corrections logged this session

- Bank accounts are not user-keyed for routing purposes. `user_bank_accounts.user_id` is for catalog ownership / 1099 attribution. The routing key for payouts is the property → bank link, snapshotted onto each ledger row.

## S66 build order — code patches against the new schema

All against schema already in place. No new migrations expected.

1. **`apps/api/src/lib/banking.ts`** (new) — ABA 9-digit checksum + Federal Reserve prefix range validator.

2. **`apps/api/src/routes/bankAccounts.ts`** (new) — user-scoped CRUD:
   - `GET /api/bank-accounts` — current user's accounts (last4 only, never decrypted)
   - `POST /api/bank-accounts` — create (validates ABA, encrypts via existing `lib/bankAccountCrypto.ts`, stores last4)
   - `PATCH /api/bank-accounts/:id` — nickname only; account/routing immutable
   - `POST /api/bank-accounts/:id/archive` — flip status to 'archived'
   - Validates `account_holder_type` ('individual' | 'business'), `account_holder_name` required, `account_type` ('checking' | 'savings').

3. **`apps/api/src/routes/admin/bankAccounts.ts`** (new) — super_admin only:
   - `GET /api/admin/users/:userId/bank-accounts` — list any user's accounts
   - `POST /api/admin/bank-accounts/:id/reveal` — decrypt + return + write to existing `audit_log` table with action='super_admin_bank_reveal', entity_type='user_bank_account', entity_id=bank account UUID, ip_address from request, new_value JSONB carries { revealed_for_user_id, revealed_at }
   - Read-only — no edit/archive endpoints exposed to admin.

4. **`apps/api/src/services/allocation.ts`** — patch `postUserLedgerEntry` to accept `bank_account_id` and stamp it on the INSERT.
   - At owner_share write: snapshot `property_allocation_rules.owner_bank_account_id` (already fetched in `fetchPropertyAndRule` — extend the SELECT)
   - At manager_fee write: snapshot `users.default_management_payout_bank_account_id` (lookup by managed_by_user_id)
   - Both can be NULL — engine continues to write the ledger row regardless.

5. **`apps/api/src/jobs/autoPayouts.ts`** — full rewrite:
   - GROUP BY (user_id, bank_account_id) on positive-balance entries via SUM(amount), only WHERE bank_account_id IS NOT NULL
   - One disbursement row per (user_id, bank_account_id) group
   - Idempotency lock keyed on `user_balance:{userId}:{bankAccountId}` instead of just userId
   - Idempotency check: skip groups with auto_friday disbursement against the same bank_account_id in last 6 days (not just per-user)
   - Withdrawal_auto entry tags the same bank_account_id it pays out from, so per-bank grouped sum nets to zero after fire
   - Fix-it-right: drop `unit_count: 0` and `target_date: CURRENT_DATE` from disbursements INSERT (vestigial post-S64; pass NULL or omit)
   - Resolve "primary active bank account" lookup → removed entirely (no longer applicable)

6. **`apps/api/src/routes/properties.ts`** — POST/PATCH allocation rule body accepts optional `owner_bank_account_id`. App-layer validation: bank account's `user_id` must equal property's `owner_user_id`. Owners cannot route to someone else's account.

7. **`packages/shared/src/index.ts`** — append:
   - `ACCOUNT_TYPE_VALUES`, `AccountType`
   - `ACCOUNT_HOLDER_TYPE_VALUES`, `AccountHolderType`
   - `BANK_ACCOUNT_STATUS_VALUES`, `BankAccountStatus`
   - `BankAccountInput`, `BankAccountSummary` interfaces

8. **`apps/landlord/src/pages/BankingPage.tsx`** (new) — list view (LLC name + last4 + account_type + holder_type badge + status), add form, per-row Archive button. No edit, no delete.

9. **`apps/landlord/src/components/layout/Layout.tsx`** — add to NAV_ITEMS in Financials section between Disbursements and Payments:
   `{ to: '/banking', icon: Landmark, label: 'Banking', section: null, roles: ['landlord'] }`
   Add `Landmark` to lucide-react import.

10. **`apps/landlord/src/main.tsx`** — register `<Route path="banking" element={<BankingPage />} />` in the Layout-nested routes block. Add `BankingPage` import.

11. **`apps/landlord/src/pages/PropertiesPage.tsx`** — extend property edit modal allocation-rule section with bank account dropdown (active accounts for current user, scoped via GET /api/bank-accounts). NULL is a valid selection. Inline "+ Add bank account" link to /banking.

## Items intentionally not in S66 scope

- **Manager portal UI** for setting `default_management_payout_bank_account_id` — no manager portal exists yet. Configure via super_admin or DB until first non-self-managed property goes live.
- **Manager-fee monthly accrual** for `flat_monthly_fee` + `per_unit_fee`. S64 implements rent_percent only.
- **Owner read-only finance view** (Step 5 of 16a).
- **Manual on-demand withdrawal endpoint + UI + fee charge** (Step 4 of 16a).
- **Micro-deposit verification** — own session post-Stripe wiring.
- **Stripe ACH firing of `pending` disbursements** — item 16. autoPayouts queues only, doesn't fire.

## Pre-launch blockers still open after S65

- **S66 entire scope** — without the CRUD endpoints + UI + autoPayouts rewrite, the per-property model has no surface to configure or any consumer that respects it.
- **Reserve fund replenishment** — webhooks.ts post-allocation hook still passes `[0]` for replenishment amount (pre-existing TODO from before S64).
- **Item 16** — Stripe transfers/payouts firing logic. Audit + likely delete `lib/stripe.ts:67` `transfers.create` and `:93` `accounts.create` (Connect-flavored, dead under current model).
- **`payments.ts:121` `initiate-disbursements`** — still uses pre-16a single-payee shape. Item 16 territory.

## DEFERRED.md cleanup

No 16a sub-items shipped; no DEFERRED.md changes this session. S65 is pure schema setup for S66.

## Files touched

- apps/api/src/db/migrations/20260503000000_user_bank_accounts_pivot_to_per_property.sql       (new)
- apps/api/src/db/migrations/20260503000100_property_allocation_rules_bank_account.sql         (new)
- apps/api/src/db/migrations/20260503000200_users_default_management_bank.sql                  (new)
- apps/api/src/db/migrations/20260503000300_user_balance_ledger_bank_account_snapshot.sql      (new)
- apps/api/src/db/schema.sql                                                                   (auto-regenerated)
- SESSION_65_HANDOFF.md                                                                        (this file)

## Tooling note

S66 is the first session running in Claude Code at `~/Downloads/gam/`. `CLAUDE.md` (gitignored) captures the standing rules and engineering principles.
