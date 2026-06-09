# Session 275 — closed (Lease lifecycle test suite + late-fee trigger fix)

## Theme

Sixth critical-path suite. Covers the recurring billing chain:
move-in invoice → monthly invoice cron → late-fee accrual. Plus
a real product fix-it-right migration that surfaced because the
test framework exercised a path no other automation did.

No frontend, no walkthrough.

## Items shipped

### Product fix — migration `20260514103000_fix_late_fee_rollup_uuid_signature.sql`

`fn_invoice_late_fee_subtotal_rollup_single` was declared with
`(p_invoice_id integer)` in the initial-schema migration, but
`invoices.id` is `uuid`. The trigger
`trg_payments_invoice_late_fee_subtotal_rollup` calls the function
with `NEW.invoice_id` (uuid) — Postgres can't resolve the
integer-argument function for a uuid input, so every late-fee
INSERT/UPDATE/DELETE errored with:

```
function fn_invoice_late_fee_subtotal_rollup_single(uuid) does not exist
```

Effect in prod: late fees would never write. Caught the moment the
new lease-lifecycle suite tried to insert a late-fee row. The fix
DROPs the bad signature and CREATEs the uuid version; the trigger
(signature-agnostic) starts resolving the correct overload.

Migration applied locally in S275; CI will apply it on the next
run via the schema.sql reload in globalSetup.

### New module — `apps/api/src/jobs/leaseLifecycle.test.ts`

21 cases across three sub-suites. All passing.

**Move-in invoice (7)**
| # | Case | What it pins |
|---|---|---|
| 1 | `moveInRentAmount` day=1 | full rent, no prorate |
| 2 | `moveInRentAmount` day=15 in 31-day month | 17/31 × rent |
| 3 | `moveInRentAmount` day=28 in Feb non-leap | 1/28 × rent |
| 4 | `generateMoveInInvoice` start_date=1st | invoice + rent payment, no fees, no deposit |
| 5 | start_date=15th + 2 move-in fees | prorated rent + fee rows, totals match |
| 6 | start_date=1st + `security_deposit` lease_fee | separate type='deposit' payment, excluded from fee count |
| 7 | Idempotent re-fire | ON CONFLICT short-circuit, single invoice row |

**Monthly invoice generation (6)**
| # | Case | What it pins |
|---|---|---|
| 8 | `dueDatesInRange` cadence | one date per month at rent_due_day |
| 9 | `dueDatesInRange` day=31 caps to Feb 28 | month-length clamp |
| 10 | `generateInvoices` happy path with `nowUtc` injection | one invoice for May 1 due-date |
| 11 | Catch-up backfill 30-day window | missed Apr 1 cycle backfills |
| 12 | Idempotent re-run | ON CONFLICT, no duplicate |
| 13 | Monthly-ongoing fees attach as payments | fee payment row + subtotal_fees |
| 14 | Skips inactive leases | terminated lease no-ops |
| 15 | Respects `lease.end_date` | no invoices past end_date |

**Late fee detection (6)**
| # | Case | What it pins |
|---|---|---|
| 16 | Initial fee on grace + 1 day past due | flat amount, status=pending |
| 17 | Cap edge | clamps to remaining cap, stops accrual |
| 18 | Idempotent re-run | unique index DO NOTHING |
| 19 | Inside grace window | scanned=0, written=0 |
| 20 | `late_fee_enabled=false` | filter excludes lease |
| 21 | `percent_of_rent` type | amount = rent × percent |

### Centralized cleanup — `apps/api/src/test/dbHelpers.ts`

Added `cleanupAllSchema()` — the union of every suite's
table-wipe list, in FK-dependency order. The S272 handoff
already flagged the duplicated cleanup lists; this session's
late-fee work added `invoices` + `invoice_sequences` to the
required set, and rather than copy-paste a 4th time the suites
were unified.

Each test file now does `beforeEach(cleanupAllSchema)` instead
of maintaining its own copy. The leaseLifecycle, depositReturn,
and webhooks suites all import and use the shared helper.

Also fixed a stale import: dbHelpers.ts now imports `db` alongside
`getClient` (the new helper needs `db.query`).

### Carry-forward from S275-of-2 (deferred to S276 lifecycle slice)

Originally scoped as a 2-session arc. This session closed the
critical-path surface — the remaining lease lifecycle bits are
edge cases worth holding for a follow-up:

- Utility line items on monthly invoices (S178 wiring — bills
  attach as payments.type='utility' on the rent invoice). Helper
  + test path is straightforward extension of the utility test
  already in webhooks.test.ts.
- Sublease branch — when subleases.status='active' covers a
  due_date, the invoice is generated for the sublessee at
  `sub_monthly_amount` instead of the master tenant at lease rent.
- Late-fee accrual ticks across multiple days (daily/weekly/
  monthly periods, `nextAccrualDate` cadence verification).
- Cron registration smoke — `registerLateFeeEngine` registers
  the handler with `timezoneCronManager`; verify it fires when
  the cron expression matches the property's local midnight.

These are stable subsystems; deferring is safe.

## Decisions made during build

| Question | Decision |
|---|---|
| Discovered late-fee trigger bug — fix forward or skip the test? | **Fix forward.** The bug breaks late fees in every environment; without the migration, the entire late-fee subsystem is broken at launch. Writing a one-function-replacement migration is dramatically cheaper than discovering this after the first delinquent tenant. CLAUDE.md fix-it-right covers it. |
| Test invoice cron with fake time injection or real time + back-dated seeds? | **Fake time via the existing `nowUtc` param.** `generateInvoices(nowUtc: Date = new Date())` already accepts an override — that's the clean hook the function was designed for. No `vi.useFakeTimers` needed. |
| Test late fees with real time or seeded due_date offsets? | **Seeded due_date offsets.** The late-fee engine's SQL uses `NOW() AT TIME ZONE p.timezone` — no parameter to inject. Seeding `due_date = today - N days` puts past-due invoices in the engine's window without touching system time, which is fragile and slows tests. |
| Centralize cleanupAll vs leave per-file | **Centralize.** Adding invoices/invoice_sequences to the cleanup list across three files was the third time this happened. Shipped a `cleanupAllSchema()` in dbHelpers.ts and migrated all three existing suites + the new leaseLifecycle suite to use it. Future suites pay nothing to add. |
| Defer session-2 scope items or push through? | **Defer.** Session 1 closed the critical-path surface — move-in + monthly cron + late-fee fire. Edge cases (utility line items, sublease branch, accrual ticks, cron registration) are not blocking launch. Captured in carry-forward for opportunistic follow-up. |

## Files touched (S275)

```
apps/api/src/jobs/leaseLifecycle.test.ts                    (new — 605 lines)
apps/api/src/test/dbHelpers.ts                              (~ cleanupAllSchema
                                                              helper + db import)
apps/api/src/services/depositReturn.test.ts                 (~ swap local
                                                              cleanupAll for
                                                              cleanupAllSchema)
apps/api/src/routes/webhooks.test.ts                        (~ swap local
                                                              cleanupAll for
                                                              cleanupAllSchema)
apps/api/src/db/migrations/
  20260514103000_fix_late_fee_rollup_uuid_signature.sql     (new — late-fee
                                                              trigger fix
                                                              migration)
apps/api/src/db/schema.sql                                  (~ auto-regenerated
                                                              by migrate runner)
DEFERRED.md                                                 (~ lease lifecycle
                                                              tombstoned with
                                                              session-2 deferrals
                                                              + bug fix note)
SESSION_275_HANDOFF.md                                      (this file)
```

## Verification

- `cd apps/api && npm test` → 69/69 passing (16 allocation + 14
  deposit-return + 18 webhook + 21 leaseLifecycle). 18s test time,
  25s including setup.
- `cd apps/api && npx tsc -b` → clean.
- `cd apps/pos && npm test` → 15/15 still passing.
- Migration applied locally; `schema_migrations` has the new
  filename + checksum. CI's globalSetup loads from `schema.sql`
  which the migrate runner regenerated.

## Carry-forward — S276+

### Session-2 lease lifecycle scope (deferred from S275)

- Utility line items on monthly invoices (S178 wiring)
- Sublease branch (sublessee rent override)
- Late-fee accrual ticks (daily/weekly/monthly cadence)
- Cron registration smoke (timezoneCronManager handoff)

### Launch list (DEFERRED order)

1. **Frontend Sentry rollout** — 9 portals. Mechanical but touches
   frontend code without test coverage; would want a walkthrough.
2. **Host pick + deploy config** — Render is the recommendation;
   needs Nic's call.
3. **Production cron runner** — coupled to host pick.
4. **Repo hygiene cleanup** — `.s*backup` + `.bak` files. ~5 min,
   multi-file delete needs Nic's permission.
5. **Console.* migration** — ongoing background work, 330 sites.

### Vendor-blocked (unchanged)

- Checkr Partner credentials pending.
- FlexCredit (CredHub + Esusu) pending.

---

End of S275 handoff.
