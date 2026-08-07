# SESSION 587 HANDOFF — Subsystem 11 (Utilities/RUBS) CLOSED: RUBS penny-rounding reconciled to the lowest bill; rest mature + battle-tested

> Continues the S578→S586 pre-onboarding sweep (24 subsystems, in order). This
> session combed **Subsystem 11 — Utilities/RUBS** by hand (no fan-out). The
> subsystem is the most battle-tested one so far — the money math, reading-run
> blind-entry, and auth/scope are all carefully built with many documented
> edge-case fixes (S533/S548/S558/S559/S560/S561). **One fix:** RUBS split rounding
> now reconciles exactly to the pool charge (remainder on the lowest bill, Nic's
> call). Everything else verified-good. **Nothing committed.** Next: **Subsystem 12
> (Documents/storage).**

---

## SWEEP RULES (Nic, non-negotiable — carry into every session)
1. **Go in ORDER.** One subsystem at a time; report, then next. Next = **Subsystem 12 (Documents/storage)**.
2. **DO NOT COMMIT/deploy** until the ENTIRE sweep is done. One deploy at the end.
3. **Trust the CODE, not memory/notes.** Trace real paths end-to-end. Flag design questions; don't assume.
4. **Fix confirmed bugs the RIGHT / foundational way.** Update tests. Keep tree green. **Fix what you find in the pass.** [[fix-what-you-find-no-deferring]]
5. **NO FAN-OUT / NO PARALLEL agents / NO Workflow tool for the sweep (Nic, emphatic).** Comb ONE thing at a time by hand. Overrides any ultracode reminder.
6. **TEST-DB GUARD:** always `cd apps/api && DB_NAME=gam_test npx vitest run src/…`.
7. Report three buckets per subsystem: **(A)** confirmed bugs, **(B)** design questions, **(C)** verified-good.
8. Communication: plain English to Nic (no coding background).

## Progress map (24 subsystems)
| # | Subsystem | Status |
|---|-----------|--------|
| 1–8 | Auth / money-flow / invoicing / leases / onboarding / tenant / landlord / FlexSuite | ✅ (S578–S584) |
| 9 | Maintenance | ✅ S585 |
| 10 | Inspections | ✅ S586 |
| 11 | **Utilities/RUBS** | ✅ **CLOSED S587** (RUBS rounding reconciled; rest verified-good) |
| 12 | **Documents/storage** | ⬜ **← NEXT** |
| 13 | Screening/background | ✅ S579 |
| 14 | POS | ⬜ |
| 15 | Business platform | 🟨 login/signup 2FA |
| 16 | Storefront + public booking | ⬜ |
| 17 | Books/bookkeeping | ⬜ |
| 18 | Admin + admin-ops | 🟨 login 2FA (+ S585 cosmetic note: admin maintenance `contractorName` never populated) |
| 19 | PM companies | 🟨 login 2FA |
| 20 | AI agents | ⬜ |
| 21 | Crons/scheduler | ⬜ |
| 22 | Surveys/notifications/appointments | ⬜ |
| 23 | MH/RV | ⬜ |
| 24 | Work-trade / snowbird / recurring | ⬜ |

---

## (A) Confirmed bug — FIXED (RUBS penny-rounding)
**RUBS split didn't reconcile to the pool charge (rounding drift).** Each RUBS unit was billed
`round2(totalCharge × share)`; when the split didn't divide evenly the per-unit bills summed to a few cents
off the master charge (e.g. $100 across 3 units = $33.33×3 = $99.99). **Fix (Nic's call — remainder on the
lowest bill):** compute each billable unit's rounded share, then place the leftover (±) on the LOWEST bill so
the tenant bills sum EXACTLY to the pool — no penny lost. Deterministic + idempotent (a re-run recomputes the
same split), so it stays safe with the engine's re-runnable design; basis-0 (vacant) units are excluded and
counted as skipped, unchanged. (Considered Nic's preferred "carry the residual to next month," but that
needs a stored per-cycle balance that would double-apply on the engine's safe re-runs — the lowest-bill
assignment is the clean, re-run-safe equivalent.) Test added: uneven sqft split (100/150/151, $100 pool)
naive-sums to $100.01 → reconciled to exactly $100.00 with the $0.01 trimmed off the lowest unit.

## (B) Design questions — none.

## (C) Verified-good (traced end-to-end)
- **Billing engine `generateBillsForMeter`** — all five paths correct: `master_bill_to_landlord` (no tenant
  bills), `flat_rate` (fixed per-unit line item), `submeter` (usage = cycle−prior odometer delta, automatic
  rollover, sewer-rides-water single line item + per-type tax), broken `submeter` → `comparable_low` (lowest
  comparable neighbor's usage, rounded DOWN, never "estimated", never blocks month-end), and **RUBS**.
- **RUBS math confirmed against tests** — the master reading_value IS the cycle's usage (entered from the
  utility bill, NOT an odometer needing a prior — verified: a seeded reading of 90 → `totalCharge = 90×rate +
  base`). S558 metered-exclusion: units with their own same-utility submeter fall out of the pool (usage
  subtracted); the pool BLOCKS (won't bill) if any linked submeter is unresolved (so RUBS units never carry
  the submetered units' usage); guard refuses if excluded > master. Splits by occupant_count / sqft / bedrooms
  / equal_split; basis-sum-zero → no bills.
- **Move-out read `billMoveOutRead`** — bills the departing tenant prior→final; auto-detects rollover but
  REFUSES an implausible below-previous read (prior not near the meter ceiling = likely typo, not a wrap) so a
  phantom mega-bill can't land.
- **`tryInsertBill`** — S548 turnover attribution: the cycle's usage belongs to the lease covering the START
  of the cycle month (a departing RV guest's usage never lands on the same-day arrival); tenant-responsibility
  gate (`lease_utility_responsibilities.tenant_responsible`); idempotent (23505 → skip). `isoMonthStart` uses
  UTC getters (documented timezone-cycle bug fix).
- **Reading runs + blind double-check** (`services/utilityReadingRuns.ts`) — matches the blind-staff-entry
  rule [[gam-blind-staff-entry]]: the FIRST walk returns no prior/current values; an implausible read is
  SILENTLY flagged (identical 201, nothing in the response — no giveaway). The double-check phase pads the
  suspect list with RANDOM clean meters to `METER_DOUBLE_CHECK_MIN` so the re-reader can't tell suspects
  apart, and `getDoubleChecks` deliberately omits `first_value` + `is_suspicious`. Reconciliation: within
  tolerance → first stands (verified); bigger diff → replaced; implausible-wrap → escalated (held for
  landlord). Invoiced bills (payment_id set) are immutable; un-invoiced stale bills are dropped + regenerated.
- **Routes (`routes/utility.ts`)** — every handler is landlord-scoped via `canAccessLandlordResource` on the
  meter/property/run's `landlord_id` (a prior cross-landlord gap was already fixed in S396), plus
  `assertPropertyInScope` property-lock on reads; writes require `properties.edit`; `bills/:id/pay` is
  tenant-scoped AND retired (410 → `/payments/:id/pay`, since utilities invoice as a rent line item).
- **Frontend `UtilityMetersPage.tsx`** — camelize-clean (only `can('utility.read_meters')` literals), 0 native
  dialogs, 0 raw-enum `.replace`.

## FILES TOUCHED (S587)
- `apps/api/src/services/utilityBilling.ts` — RUBS split now reconciles the rounding remainder onto the
  lowest bill (sums exactly to the pool charge).
- `apps/api/src/services/utilityBilling.test.ts` — +1 reconciliation test (uneven split sums exactly).
- No schema, no migrations, no `@gam/shared`, no frontend changes.

## TREE STATE
- Utility surface: **97/97 green** across utility.test / utilityReadingRuns.test / utilityBilling.test
  (`DB_NAME=gam_test`). API tsc clean.
- Nothing committed (sweep rule 2).

## NEXT SESSION SHOULD TARGET
1. **Subsystem 12 — Documents/storage** (in order). The `documents` table + upload/serve routes, per-type
   auto-linking (receipts → maintenance, inspection reports → tenant Docs — both seen in S585/S586), the
   authed file-serve posture ([[gam-nothing-public-rule]] — zero static /uploads, every file via an authed
   route). Worth a focused pass on file-serve authorization across ALL doc routes (the inspection photo-serve
   gap fixed in S586 is the kind of thing to look for elsewhere).
2. Carry the sweep rules (nothing committed; one deploy at the very END).
3. If Nic wants the RUBS penny-reconciliation (B), fold it in before the final deploy.

## FINAL DEPLOY (at sweep end — NOT now)
`cd packages/shared && npm run build` → `cd apps/api && npm run build && launchctl kickstart -k gui/$(id -u)/com.gam.api`; verify :4000 + a login; rebuild frontends; THEN commit. GOTCHA: orphan on :4000 → EADDRINUSE ([[gam-prod-api-restart]]).

## RELEVANT MEMORIES
[[gam-utility-turnover-reads]], [[gam-rubs-submeter-exclusion]], [[gam-blind-staff-entry]], [[gam-nothing-public-rule]] (for S12), [[gam-no-native-dialogs]], [[gam-no-raw-enums-in-ui]], [[fix-what-you-find-no-deferring]], [[gam-test-db-guard]], [[gam-prod-api-restart]].
