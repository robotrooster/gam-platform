# Session 196 — closed

## Theme

Phase 2 of the `leases.security_deposit` deprecation. S195
shipped phase 1 (lease_fees CHECK extension + backfill +
dual-write at all writer sites). S196 finishes:

- Reader cutover: depositReturn reads the deposit from lease_fees
- Frontend response shape preserved via scalar subquery on every
  lease-read path (`SELECT amount FROM lease_fees ...` exposed as
  `security_deposit` in the response, case-converted to
  `securityDeposit` for frontend)
- `WRITABLE_LEASE_COLUMN_SPECS` no longer includes security_deposit
- `FEE_ROW_SPECS` + `FEE_TYPE_META` now include security_deposit
- Inline INSERT statements at the four direct-INSERT sites stripped
  of the security_deposit column
- moveInBundle.ts: input parameter dropped; deposit comes through
  the lease_fees iteration; preserved type='deposit' payment row
  semantic via fee-array partitioning
- Migration drops `leases.security_deposit` column

## What S196 shipped

### Migration `20260508170000_drop_leases_security_deposit.sql`

Single statement: `ALTER TABLE leases DROP COLUMN IF EXISTS security_deposit;`
Idempotent guard. Applied; schema.sql regenerated.

### Shared package — `packages/shared/src/index.ts`

- `WritableLeaseColumn` union: removed `'security_deposit'`
- `WRITABLE_LEASE_COLUMN_SPECS`: removed the security_deposit entry
- `LEASE_COLUMN_CATEGORY['security_deposit']`: changed from
  `'writable'` to `'fee_row'`
- `FeeRowTag` / `FEE_TYPES` / `FEE_TYPE_META` / `FEE_ROW_SPECS`:
  added `security_deposit` (refundable, move_in)

`LEASE_COLUMNS` array kept the `'security_deposit'` member (it's
still a valid lease-document field-binding tag for parsing /
templates; the change is which pipeline processes it at lease
finalize — fee_row instead of writable).

### Backend services

- **`services/depositReturn.ts`** — `calculateDepositReturn`
  reads the deposit from `lease_fees` (fee_type='security_deposit',
  due_timing='move_in') when no `security_deposits` row exists.
  Pre-S196 it fell back to `lease.security_deposit`.
- **`services/leaseFeesSync.ts`** — `syncSecurityDepositLeaseFee`
  helper STAYS. Used by writers that don't go through
  FEE_ROW_SPECS (landlords.ts onboarding paths, leases.ts PATCH,
  resolveIntent.ts lease parser). Removed from esign.ts where
  FEE_ROW_SPECS now does the work.

### Backend routes

- **`routes/leases.ts`**: every `SELECT l.*` lease-read path now
  includes a scalar subquery `(SELECT amount FROM lease_fees ...) AS security_deposit`
  to preserve the response shape (camelCased to
  `securityDeposit` via existing case converter so no frontend
  changes needed).
- **`routes/leases.ts`** PATCH: removed `security_deposit` from
  the dynamic `fields` UPDATE map; `syncSecurityDepositLeaseFee`
  handles it.
- **`routes/landlords.ts`** (onboard-tenant + csv commit-pending):
  removed `security_deposit` column from the inline INSERT;
  `syncSecurityDepositLeaseFee` writes the lease_fees row.
- **`routes/esign.ts`** (`buildLeaseFromDocument`): the dynamic
  INSERT no longer writes the column (since it's no longer in
  WRITABLE_LEASE_COLUMN_SPECS). FEE_ROW_SPECS iteration handles
  the lease_fees write. The S195 dual-write helper call removed
  to avoid double-insert.
- **`jobs/leaseParser/resolveIntent.ts`**: removed
  `security_deposit` column from the inline INSERT; helper writes
  lease_fees row.

### moveInBundle.ts simplification

- `MoveInInputs` interface: dropped `security_deposit` field.
- Function body: locates security_deposit lease_fee in the
  `fees` array, partitions it out from `nonDepositFees`, retains
  the dedicated type='deposit' payment-row insert (preserves
  audit-clarity semantic — security_deposit historically rendered
  as type='deposit', not type='fee'; only consumer that filters
  on payments.type='deposit' is moveInBundle itself, but keeping
  the distinct row type protects future reports).
- Fee loop iterates `nonDepositFees` to avoid double-counting.
- `esign.ts` call site: dropped `security_deposit:` field from the
  generateMoveInInvoice payload.

### Files touched (S196)

```
apps/api/src/db/migrations/20260508170000_drop_leases_security_deposit.sql  (NEW — drop column)
apps/api/src/db/schema.sql                                                  (regenerated)
packages/shared/src/index.ts                                                (WritableLeaseColumn / WRITABLE_LEASE_COLUMN_SPECS / LEASE_COLUMN_CATEGORY / FeeRowTag / FEE_TYPES / FEE_TYPE_META / FEE_ROW_SPECS)
apps/api/src/services/depositReturn.ts                                      (calculateDepositReturn reads from lease_fees; type signature drops lease.security_deposit)
apps/api/src/routes/leases.ts                                               (scalar subquery on GET / + GET /:id + post-PATCH SELECT; PATCH fields object drops security_deposit)
apps/api/src/routes/landlords.ts                                            (onboard-tenant + csv commit-pending INSERT statements stripped of security_deposit column)
apps/api/src/routes/esign.ts                                                (buildLeaseFromDocument: removed S195 dual-write helper call (FEE_ROW_SPECS now handles); dropped securityDepositNum + security_deposit field from generateMoveInInvoice call)
apps/api/src/jobs/leaseParser/resolveIntent.ts                              (INSERT statement stripped of security_deposit column)
apps/api/src/jobs/moveInBundle.ts                                           (MoveInInputs.security_deposit field removed; fee-array partitioning to extract security_deposit lease_fee for the dedicated type='deposit' payment row)
```

### Verification

- `npm run db:migrate` → applied; schema.sql regenerated; column gone
- `cd packages/shared && npx tsc -b` → 0
- `cd apps/api && npx tsc --noEmit` → 0
- `cd apps/landlord && npx tsc --noEmit` → 0
- `cd apps/tenant && npx tsc --noEmit` → 0
- `psql gam -c "\d leases"` shows no security_deposit column

## Decisions made (S196)

| Question | Decision |
|---|---|
| Drop the column or keep it as a denormalized cache of the lease_fees value? | Drop. Two sources of truth → drift → bugs. The scalar subquery on lease-read paths is cheap (indexed on lease_id, single row per lease) and keeps the response shape stable for the frontend. |
| Migrate frontend lease form (LeaseFormModal) to read from a different field? | No. Backend response now contains `security_deposit` (case-converted to `securityDeposit`) sourced from lease_fees via scalar subquery — frontend reads the same field name as before. Zero frontend churn. |
| Remove the `syncSecurityDepositLeaseFee` helper entirely now that FEE_ROW_SPECS handles it? | No, keep. Three writer paths (landlords.ts onboarding, leases.ts PATCH, resolveIntent.ts) don't go through FEE_ROW_SPECS — they need the helper. Only esign's dynamic INSERT loops FEE_ROW_SPECS, so only that helper-call was removed. |
| Preserve `payments.type='deposit'` semantic at move-in vs collapse to `type='fee'` with `entry_description='DEPOSIT'`? | Preserve. The dedicated type='deposit' row is historical signal for "this is THE security deposit." Even though no consumer currently filters on it, future reports will benefit from the distinct payment_type. The fee-array partitioning keeps the legacy shape with minimal code. |
| Backfill stamp on the lease_fees rows from S195 — keep "S195 backfill from leases.security_deposit" description, or normalize? | Kept the backfill description. Tells future-Claude reading the rows where they came from. New rows get description='Security deposit' from the helper. |

## Carry-forward — remaining substantial items

Per the S195 carry-forward + the broader queue:

- **Stripe Connect S113 destination charges rebuild** — biggest pre-launch blocker. Multi-session, needs real test keys.
- **Sublease subsystem** — multi-session new feature, locked-build per S177.
- **B1+B2 material-change workflow** — multi-session.
- **C1 50-state property tax form catalog** — multi-session per-state research + build.
- **POS Terminal hardware + EOD** — multi-session, needs hardware.

### Smaller pending

- B3 thread polish: needs-ack filter, SchedulePage tile badge, hard-gate check-in product call (S191 carry)
- A3 thread continuations:
  - `properties.deposit_interest_rate_annual` columns audit/drop (S193 discovery)
  - Expand state catalog (S188)
  - Annual rate refresh discipline doc (S188/S190)
  - Landlord-side rate visibility on lease draft preview (S194)
- Primary manager urgency tier (S185 question)
- Owner-financial-escalation pattern (S186 question)
- Other POS tables for property scoping (S192 carry)
- D2 Flex tenant suite (launch-flag gated)
- CSV imports (vendor format specs)
- E2 npm upgrades (risky)
- F1 Marketing rebuild (positioning paragraph)

---

End of S196 handoff.
