# Session 265 — closed (Vitest harness + first critical-path suite)

## Theme

Production infrastructure work, item 1: tests. DEFERRED.md flagged
test coverage as "the single biggest launch risk." S265 wires the
Vitest harness against a real `gam_test` Postgres fixture and ships
the first critical-path suite — the rent allocation engine.

No frontend work this session, no walkthrough required.

## Items shipped

### New module — `apps/api/vitest.config.ts`

Vitest config:
- `include: src/**/*.test.ts`
- excludes the legacy hand-rolled `caseConversion.test.ts` (it's a
  script, not a Vitest spec — leave in place per S29's no-delete
  policy; can be migrated to Vitest in a follow-up).
- `pool: 'forks'` + `singleFork: true` + `fileParallelism: false`
  — DB-backed tests must serialize.
- 20s test timeout, 60s hook timeout (handles the global setup's
  drop/create/load-schema cycle).

### New module — `apps/api/src/test/globalSetup.ts`

Runs once before the suite:
- Reads `apps/api/src/db/schema.sql` (the auto-generated snapshot
  that the migration runner updates after every apply).
- Drops + recreates `gam_test` (the name must end in `_test` —
  guard against pointing tests at the dev DB).
- Loads the schema into the fresh database.
- Sets `process.env.DB_NAME = TEST_DB_NAME` so when the test workers
  fork and the db singleton initializes, it connects to `gam_test`.
  Backed up by the `DB_NAME=gam_test` prefix on the npm script.

Strips `\restrict` / `\unrestrict` lines from schema.sql before
loading — pg_dump 16+ emits those as psql meta-commands and the
node `pg` driver can't execute them.

Reuses the schema snapshot instead of replaying 107 migrations,
saves ~30s per run.

### New module — `apps/api/src/test/dbHelpers.ts`

- `withRollback(fn)` — runs `fn(client)` inside a BEGIN/ROLLBACK
  pair. The schema stays clean between tests at zero cost.
- Seed factories: `seedLandlord`, `seedManager`, `seedTenant`,
  `seedProperty`, `seedUnit`, `seedAllocationRule`,
  `seedProcessingRate`, `seedRentPayment`. Each accepts only the
  fields that vary per test; defaults match the schema CHECK
  constraints + the GAM pricing model.

Notable wiring details that bit during the build:
- `payments.tenant_id` FKs to `tenants.id`, not `users.id`.
  `seedTenant` returns the tenants.id (after inserting both users
  + tenants rows under the hood).
- `landlords` is a distinct table keyed off `users`. `seedLandlord`
  returns both `userId` (for FK targets in properties.owner_user_id /
  managed_by_user_id) and `landlordId` (for payments.landlord_id /
  properties.landlord_id).

### New module — `apps/api/src/services/allocation.test.ts`

10 cases on the rent allocation entry point
(`executeRentAllocation`). All passing.

| # | Case | What it pins |
|---|---|---|
| 1 | Owner self-managed, ACH fee to tenant | gross → owner_share, spread → platform |
| 2 | Owner self-managed, ACH fee to landlord | splittable = gross − cf_fee |
| 3 | Separate manager, rent_percent=10, landlord absorbs ACH | manager_fee computed off splittable |
| 4 | rent_percent clamps to floor | `mc < floor` → use floor |
| 5 | rent_percent clamps to ceiling | `mc > ceiling` → use ceiling |
| 6 | Supersedence boost present | owner_share absorbs it, manager_fee untouched |
| 7 | Re-invoking on same paymentId | second call no-ops (idempotency short-circuit) |
| 8 | type='fee' payment | rejects with 400 (`payment.type='rent'`) |
| 9 | No allocation rule | rejects with 409 (`no allocation rule`) |
| 10 | Card payment with split toggles | reads `card_fee_payer`, not `ach_fee_payer` |

Deferred to a follow-up suite: PM company cut path
(`pm_company_id` present), platform_processing_rate gating,
flat_monthly_fee variant, the seven supersedence-source FIFO cases.

### Package + script wiring

`apps/api/package.json`:
- `vitest@^1.6.1` added to devDependencies (62 packages installed).
- `"test": "DB_NAME=gam_test vitest run"` script.
- `"test:watch": "DB_NAME=gam_test vitest"` script.

## Decisions made during build

| Question | Decision |
|---|---|
| Migration replay vs schema snapshot for test DB | **Schema snapshot.** Replaying 107 migrations per test run would cost ~30s of cold start; `schema.sql` is regenerated after every migration apply already, so it's the same source of truth. Single fast load. |
| Per-test cleanup strategy | **`BEGIN`/`ROLLBACK` wrapper.** No truncation cost, no test ordering coupling, no shared-state leakage. Required `executeRentAllocation` to be tx-aware already — it is. Processing rates are seeded once in `beforeAll` outside the per-test tx because they're a global singleton anyway and don't conflict with per-test inserts. |
| How to override `DB_NAME` for tests | **`DB_NAME=gam_test` prefix on the npm script** + `process.env.DB_NAME` mutation in globalSetup as belt-and-suspenders. `dotenv.config()` in db/index.ts preserves existing env vars (verified) so the .env file's `DB_NAME=gam` doesn't clobber. |
| `\restrict` psql meta-commands in schema.sql | **Strip in-memory before load.** pg_dump 16+ emits these for new restriction-mode features; the node `pg` driver rejects them as syntax errors. Filtering backslash-prefixed lines is a safe one-liner — they carry no DDL. |
| Vitest pool/parallelism config | **Single fork, serial.** Every test hits the same gam_test database; parallel forks would step on each other even with the BEGIN/ROLLBACK guard (advisory locks, race on shared singleton rows). Slow but correct. If suite gets slow enough to matter, separate test DBs per worker is the cleanup path. |
| Leave `caseConversion.test.ts` alone | **Yes.** It's a hand-rolled script that pre-dates Vitest and exits non-zero on failure (which a CI step could still pick up). Migrating it to `expect(...)` form is a 5-min cleanup but not load-bearing for the launch list. Excluded from the vitest glob explicitly. |

## Files touched (S265)

```
apps/api/vitest.config.ts                  (new — 13 lines)
apps/api/src/test/globalSetup.ts           (new — 81 lines)
apps/api/src/test/dbHelpers.ts             (new — 184 lines)
apps/api/src/services/allocation.test.ts   (new — 367 lines)
apps/api/package.json                      (~ added vitest dep + 2 scripts)
apps/api/package-lock.json                 (~ npm install side-effect)
DEFERRED.md                                (~ Tests section: allocation
                                            tombstoned, harness shipped
                                            noted, remaining items
                                            re-prioritized; CI section
                                            updated)
SESSION_265_HANDOFF.md                     (this file)
```

## Verification

- `cd apps/api && npm test` → 10 passed, 0 failed, 8.5s.
- `cd apps/api && npx tsc -b` → clean.
- `gam_test` database confirmed dropped + recreated on each suite
  run.

## Carry-forward — S266+

Production-infrastructure list (DEFERRED.md is the source of truth).
Next sessions in roughly this order:

### Test coverage — keep grinding

Each of these is its own session-sized chunk:

1. **Allocation — PM company cut path.** The four percent fee_type
   variants (`percent_of_rent`, `percent_with_floor`,
   `percent_with_ceiling`, plus `flat_monthly`/`per_unit`/
   `leasing_fee` as zero-path). Reuse the existing harness; add a
   `seedPmCompany` + `seedPmFeePlan` to `dbHelpers.ts`.
2. **Rent webhook handler.** `routes/webhooks.ts` Stripe webhook
   path → settles payment → invokes allocation. Mock the Stripe
   SDK call; assert payment row transitions + allocation rows.
3. **Deposit-return finalize.** `services/depositReturn.ts`
   `finalizeDepositReturn` → `collected_amount` pool + Connect
   Transfer call (mock Stripe).
4. **POS sync queue.** Lives in `apps/pos`, not `apps/api` — needs
   its own Vitest config with `jsdom` + `fake-indexeddb` shim. The
   FIFO/4xx-discard/5xx-backoff/clientId-resolution semantics are
   the surface.
5. **Lease lifecycle integration.** Sign → move-in invoice →
   monthly invoice cron → late-fee on grace expiry. Touches several
   services; reuse the harness with timezone control + fake clock.

### CI/CD (deferred — order TBD)

`.github/workflows/ci.yml` with a Postgres service container, runs
`tsc -b` + `npm test` for apps/api on push. ~1 session.

### Vendor-blocked (unchanged)

- Checkr Partner credentials pending (Monday per S264).
- FlexCredit (CredHub + Esusu) pending.

## Possible follow-ups discovered this session

- `schema.sql` strip-on-load runs every suite run. If pg_dump output
  changes upstream and introduces new meta-commands, the strip
  filter needs to extend. Worth noting in `dump-schema.sh`
  comments — but not blocking now.
- The hand-rolled `caseConversion.test.ts` should eventually
  migrate to Vitest `it()/expect()` form (~5 min). Excluded from
  the suite for now.
- `node-cron` import side-effects in `src/jobs/scheduler.ts` —
  importing app code in tests will instantiate cron timers if the
  test imports transitively reach scheduler. So far the allocation
  test only imports `db` + `allocation`; if a future suite imports
  routes that pull in scheduler, the timer side-effects need to be
  isolated. Watch for it.

---

End of S265 handoff.
