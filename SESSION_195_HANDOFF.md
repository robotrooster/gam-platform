# Session 195 — closed

## Theme

Phase 1 of 2 — `leases.security_deposit` → `lease_fees`
deprecation. Locked direction; deferred 8+ sessions; finally
shipped.

This session: schema migration (extend `lease_fees.fee_type` CHECK
to include `'security_deposit'`, mirror on `property_fee_schedules`,
backfill existing leases) + dual-write at every writer site so
the catalog and the legacy column stay in sync.

Phase 2 (next session): switch readers to lease_fees, stop dual-
writing, drop the legacy `leases.security_deposit` column,
remove from `WRITABLE_LEASE_COLUMN_SPECS` in @gam/shared.

## What S195 shipped

### Migration `20260508160000_lease_fees_security_deposit.sql`

- `lease_fees_fee_type_check` and `property_fee_schedules_fee_type_check`
  both extended with `'security_deposit'` (kept the two enums in
  lockstep per existing convention).
- Backfill `INSERT ... SELECT FROM leases WHERE security_deposit > 0`
  with idempotency guard (`NOT EXISTS` lookup against existing
  security_deposit/move_in row). Dev DB had 0 matching leases →
  no-op runtime, SQL correct for any prod data.

### Service helper `services/leaseFeesSync.ts`

`syncSecurityDepositLeaseFee(leaseId, amount, client?)`. Pattern is
delete-then-insert because lease_fees has no UNIQUE constraint on
`(lease_id, fee_type, due_timing)` (multiple move_in rows of
different fee_types is the normal case — each fee_type gets its
own row). DELETE removes any prior security_deposit row; INSERT
creates the new one. Skips INSERT when amount ≤ 0 (no point
storing $0 line items).

Accepts an optional `PoolClient` so callers in transactions can
share connection — needed by esign's lease-build path which holds
its own tx, by leaseParser/resolveIntent, and by the two
landlords.ts onboarding paths.

### Dual-write wired at every leases.security_deposit writer

| Site | Context | Wired |
|---|---|---|
| `routes/esign.ts` (buildLeaseFromDocument) | INSERT INTO leases via dynamic writableCols at lease finalize | ✓ helper called post-INSERT inside the tx |
| `routes/leases.ts` (PATCH /:id) | UPDATE leases SET security_deposit | ✓ helper called when `body.securityDeposit !== undefined` |
| `routes/landlords.ts` (POST /me/onboard-tenant) | Manual onboarding INSERT | ✓ helper called inside tx, before COMMIT |
| `routes/landlords.ts` (POST /me/onboard-tenants-csv/commit-pending) | CSV bulk import INSERT (loop) | ✓ helper called inside tx, per-lease |
| `jobs/leaseParser/resolveIntent.ts` | Imported lease (PDF parser) INSERT | ✓ helper called post-INSERT inside tx |

All five sites now write to BOTH the legacy `leases.security_deposit`
column AND the new `lease_fees` row at lease creation/update time.

### Files touched (S195)

```
apps/api/src/db/migrations/20260508160000_lease_fees_security_deposit.sql  (NEW)
apps/api/src/db/schema.sql                                                 (regenerated)
apps/api/src/services/leaseFeesSync.ts                                     (NEW — syncSecurityDepositLeaseFee helper)
apps/api/src/routes/esign.ts                                               (post-INSERT dual-write in buildLeaseFromDocument)
apps/api/src/routes/leases.ts                                              (PATCH dual-write when securityDeposit in body)
apps/api/src/routes/landlords.ts                                           (onboard-tenant + csv commit-pending dual-writes)
apps/api/src/jobs/leaseParser/resolveIntent.ts                             (post-INSERT dual-write in lease parser)
```

### Verification

- `npm run db:migrate` → applied; schema.sql regenerated
- `psql gam -c "SELECT COUNT(*) FROM lease_fees WHERE fee_type='security_deposit';"` → 0 (empty dev DB; backfill SQL correct for prod)
- `cd apps/api && npx tsc --noEmit` → 0
- No frontend changes (frontend still reads from leases.security_deposit; phase 2 will switch)

## Decisions made (S195)

| Question | Decision |
|---|---|
| Dual-write or cut over directly? | Dual-write. Phase 2 needs to switch readers safely; if I'd cut over writers in this session AND missed any reader site, that reader would silently see 0 deposits until phase 2 catches it. Dual-write keeps both surfaces consistent during the transition; phase 2 can verify readers and then drop the legacy column atomically. |
| Helper signature: pass `client` or accept tx-less? | Both. All five existing writer sites have an open tx (esign + leaseParser + onboarding paths) so they pass the client; the leases.ts PATCH path doesn't have a tx, so it falls back to the pool. Helper's optional-client signature handles both. |
| INSERT-then-DELETE vs DELETE-then-INSERT? | DELETE-then-INSERT. Cleaner with no UNIQUE constraint to upsert against, and the order avoids a transient state where two security_deposit rows exist for the same lease. |
| Backfill on `WHERE security_deposit IS NOT NULL AND security_deposit > 0` — also pick up rows with NULL? | No. NULL means "deposit not specified" semantically; backfilling NULL → $0 lease_fee row would create a meaningless line item. Leave NULL/0 leases without a lease_fee row. |
| Frontend updates? | Skipped this session. Frontend (lease form, lease display) reads from leases.security_deposit. Switching it is part of phase 2's reader cutover. Dual-write means the legacy column is still authoritative until phase 2 ships. |

## Carry-forward — phase 2 punch list

**Session 196 priority** — `leases.security_deposit` deprecation
phase 2:

1. **Reader switch** — point all readers at lease_fees:
   - `services/depositReturn.ts:179` (currently `sd?.total_amount ?? lease.security_deposit ?? 0`) → fall back to lease_fees row instead
   - `routes/reports.ts:364` (`SUM(security_deposit)` rollup) → SUM(amount) FROM lease_fees WHERE fee_type='security_deposit'
   - `services/depositReturn.ts:158,164` type signatures (lease.security_deposit string field) → update consumers
   - Frontend lease display (apps/landlord LeasesPage, LeaseFormModal, etc.) — read from lease_fees move_in catalog
2. **Stop dual-writing** — remove the syncSecurityDepositLeaseFee
   calls; the helper itself stays for now (could become a generic
   `syncLeaseFeeRow` later).
3. **Drop column migration** — `ALTER TABLE leases DROP COLUMN security_deposit`. Single statement, irreversible.
4. **Update `WRITABLE_LEASE_COLUMN_SPECS`** in `packages/shared/src/index.ts` — remove `security_deposit` so the dynamic INSERT in esign.ts no longer tries to write it.
5. **Remove from leaseTypes**, etc. — anywhere `security_deposit` is named in shared types.
6. **Frontend updates** for lease forms — replace direct security_deposit field with a lease_fees-backed move_in deposit row.
7. **moveInBundle.ts** — drop the separate `security_deposit` input parameter; the deposit will come through the lease_fees move_in iteration like every other fee.

### Already-known carry-forward (unchanged)

- Stripe Connect S113 destination charges rebuild (real pre-launch blocker)
- Sublease subsystem (multi-session)
- B1+B2 material-change workflow (multi-session)
- C1 50-state property tax form catalog (multi-session)
- B3 thread polish: needs-ack filter, SchedulePage tile badge, hard-gate check-in product call
- Primary manager urgency tier (S185 question)
- Owner-financial-escalation pattern (S186 question)
- Other POS tables for property scoping (S192 carry)
- `properties.deposit_interest_rate_annual` columns audit/drop (S193 discovery)
- Expand state catalog for deposit interest (S188 carry)
- Annual rate refresh discipline doc (S188/S190 carry)
- Landlord-side rate visibility on lease draft preview (S194 carry)
- D2 Flex tenant suite (launch-flag gated)
- POS Terminal hardware + EOD
- CSV imports
- E2 npm upgrades
- F1 Marketing rebuild

---

End of S195 handoff.
