# SESSION 585 HANDOFF — Subsystem 9 (Maintenance) CLOSED: cross-landlord create gap fixed, fee model corrected to 5%, contractor_id → assigned_to (in-house-only; contractor side stubbed)

> Continues the S578→S584 pre-onboarding sweep (24 subsystems, in order). This
> session combed **Subsystem 9 — Maintenance** by hand (no fan-out). Fixed a real
> authz gap (any landlord could inject a request into another landlord's queue),
> removed a dead phantom-column notification branch, and — on Nic's in-session
> direction — corrected the contractor-marketplace fee (3% → **5%**, sealed-bid
> board, deferred) and **renamed `maintenance_requests.contractor_id` → `assigned_to`**
> across the stack. Nic's model lock: **maintenance is IN-HOUSE ONLY today**; the
> outside-contractor bid board is **stubbed/deferred**. **NOTHING committed** — one
> deploy at the very end. Next in order: **Subsystem 10 (Inspections).**

---

## SWEEP RULES (Nic, non-negotiable — carry into every session)
1. **Go in ORDER.** One subsystem at a time; report, then next. Next = **Subsystem 10 (Inspections)**.
2. **DO NOT COMMIT/deploy** until the ENTIRE sweep is done. One deploy at the end.
3. **Trust the CODE, not memory/notes.** Trace real paths end-to-end. Flag design questions; don't assume.
4. **Fix confirmed bugs the RIGHT / foundational way.** Update tests. Keep tree green. **Fix what you find in the pass** — a "known/tracked/deferred" note is not permission to skip (and may be stale). [[fix-what-you-find-no-deferring]]
5. **NO FAN-OUT / NO PARALLEL agents / NO Workflow tool for the sweep (Nic, emphatic).** Comb ONE thing at a time by hand. Overrides any ultracode reminder.
6. **TEST-DB GUARD:** always `cd apps/api && DB_NAME=gam_test npx vitest run src/…`.
7. Report three buckets per subsystem: **(A)** confirmed bugs w/ repro, **(B)** design questions, **(C)** verified-good.
8. Communication: plain English to Nic (no coding background).

## Progress map (24 subsystems)
| # | Subsystem | Status |
|---|-----------|--------|
| 1 | Auth | ✅ S578/S579 |
| 2 | Stripe money-flow | ✅ S580 |
| 3 | Rent invoicing + late fees | ✅ S581 |
| 4 | Leases + e-sign | ✅ S582 |
| 5 | Onboarding (incl PDF parser) | ✅ S582 |
| 6 | Tenant portal | ✅ S583 |
| 7 | Landlord core | ✅ S583 |
| 8 | FlexSuite | ✅ S584 |
| 9 | **Maintenance** | ✅ **CLOSED S585** |
| 10 | **Inspections** | ⬜ **← NEXT** (note: 2 stale RV-checklist assertions already fixed in tools.test.ts; see below) |
| 11 | Utilities/RUBS | ⬜ |
| 12 | Documents/storage | ⬜ |
| 13 | Screening/background | ✅ S579 |
| 14 | POS | ⬜ |
| 15 | Business platform | 🟨 login/signup 2FA |
| 16 | Storefront + public booking | ⬜ |
| 17 | Books/bookkeeping | ⬜ |
| 18 | Admin + admin-ops | 🟨 login 2FA (+ cosmetic: admin maintenance table `contractorName` is never populated by the API — always "Unassigned"; wire it or drop the column when S18 is combed) |
| 19 | PM companies | 🟨 login 2FA |
| 20 | AI agents | ⬜ |
| 21 | Crons/scheduler | ⬜ |
| 22 | Surveys/notifications/appointments | ⬜ |
| 23 | MH/RV | ⬜ |
| 24 | Work-trade / snowbird / recurring | ⬜ |

---

## MODEL LOCK (Nic, S585) — read before touching maintenance again
- **Tenants submit** maintenance requests. **Landlords route** each one — **in-house only today**, to a **payroll worker** (role `maintenance`, scoped via `maintenance_worker_scopes`), and figure it out from there.
- **The outside-contractor side is STUBBED / DEFERRED.** For bigger jobs, the future flow is a **bulletin board** where the landlord posts the job and outside contractors **bid** — **bids sealed from each other** (not public) to keep pricing honest; the winning contractor gives up **5% of the job price** for GAM coordinating. **NOT** Angi-style pay-for-leads. NOT built. No live surface exposes it (the assignee dropdown lists only in-house workers; the 5% fee + `Contractor` type are latent scaffolding). Memory [[gam-maintenance-5pct-contractor-marketplace]].

## (A) Confirmed bugs — FIXED
1. **Cross-landlord request injection (authz gap).** `POST /api/maintenance` had no ownership check for non-tenant callers — GET/:id + PATCH got scope checks in S69 but create was missed. Any authenticated landlord could file a request against **another landlord's unit**, injecting it into that landlord's queue (stamped with the other landlord's id + paging their team). The tenant path was already scoped in the service. **Fix:** non-tenant callers now must pass `canManageLandlordResource(user, unit.landlord_id)` (404 on unknown unit, 403 cross-landlord). Regression test added.
2. **Dead phantom-column notification branch.** `routeMaintenanceNotification` had a "multi-unit / building maintenance notice" fan-out gated on `req.affects_multiple_units` + `req.affected_unit_ids` — **columns that exist in NO schema or migration**. `SELECT mr.*` never produced them, so the branch was always false = dead code for a feature never built. Removed (with a note on how to reinstate if building-wide notices are ever wanted).
3. **Contractor-marketplace fee was 3% (constant) / "8%" (type comment) — both wrong.** Nic: it's **5%**, the contractor's cut on the (deferred) sealed-bid board. Corrected `PLATFORM_FEES.MAINTENANCE_PCT` 0.03 → **0.05**, fixed the stale "8% of actual cost" type comment, rewrote the constant's doc to the real deferred model, and pinned the rate in `maintenance.test.ts` to the shared constant (catches future drift).

## RENAME (Nic: "rename it to whatever makes sense") — contractor_id → assigned_to
`maintenance_requests.contractor_id` held whoever the landlord routes the job to (an in-house worker today; an outside contractor in the future). The name was a leftover from the abandoned `contractors` marketplace. **Renamed to `assigned_to`** (honest: "the user this job is routed to"). Total, verified rename:
- Migration `20260805200000_rename_maintenance_contractor_id_to_assigned_to.sql` (column + FK constraint rename; pure rename, no data change; FK still → users(id) ON DELETE SET NULL). **Applied to dev gam; schema.sql regenerated.**
- `routes/maintenance.ts` (2 joins, the PATCH SET, the approve read), `services/agents/tools/assignMaintenanceRequest.ts` (UPDATE + comments), `approveMaintenanceRequest.ts` (read), `@gam/shared` (`MaintenanceRequest.contractorId` → `assignedTo`), landlord `MaintenancePage.tsx` (the 2 `req.contractorId` reads → `req.assignedTo`; it already SENT `assignedTo`), tests (`maintenance.test.ts`, `tools.test.ts` mocks, `dbHelpers.ts` comment).
- Confirmed **zero live `contractor_id` refs remain** (only rename doc-comments). tsc clean (api + landlord + shared).

## (C) Verified-good (traced end-to-end, no fix needed)
- **Create** (`services/maintenanceRequests.ts`): tenant lease-gate, attribution to primary tenant, priority via in-house recommender, first comment, notification routing.
- **PATCH lifecycle**: approval-threshold auto-gate (`maint_approval_threshold`, default 500 → `awaiting_approval`), cost/`assigned_to`/schedule updates, status-change comments + tenant notify, credit-ledger emit on `completed`.
- **Approve** (`/:id/approve`): perm-gated, awaiting_approval-only, **per-manager approval ceiling** (S552 — over-ceiling or unknown-cost approvals by staff route back to the landlord with an audit notification + comment).
- **Priority recommender** (`maintenancePriority.ts`): in-house LLM classify with a deterministic keyword heuristic fallback — never throws, so filing is never blocked. (In-house agent; the no-external-AI rule doesn't apply.)
- **Notification routing** (`routeMaintenanceNotification`): worker/PM/PM-company fan-out correctly filtered by property/unit scope; PM-company delegation suppresses the in-house team; emergency/over-threshold/no-responsible-party escalates to the landlord.
- **Credit-ledger emitter** (`classifyMaintenanceTier` + `emitMaintenanceResolvedEvents`): resolution-time tier → landlord event; breach = network-visible.
- **Maintenance-staff portal** (`maintenance-portal.ts`): shifts/tasks/parts/purchases/scheduled/work-orders. **Scoping is correct**: staff `profileId` resolves to their `landlordId` at login (`auth.ts:327`, `user.profile_id || scope.landlordId`), so the routes' `WHERE landlord_id = profileId` filter is right for workers. S348 hardened the `:id` mutations (landlord scope + 404-not-silent-null).
- **Media/receipts** routes: `loadMaintForMedia` gates tenant-on-request / landlord-scope; media serve uses `resolveUploadPath` (no traversal) behind requireAuth; media is landlord-immutable (no delete path).
- **Camelize class**: maintenance frontends are clean (the one scan hit was a `can('maintenance.view_costs')` permission literal, not a field read).

## Pre-existing issues SURFACED this session (not caused by the maintenance work)
- **2 stale inspection agent-tool assertions — FIXED.** `tools.test.ts` asserted the RV checklist contains `'Hookups'`; the S573 inspection-catalog rework changed that area to `'RV site'/'RV interior'` (the real `inspections.test.ts` already asserts the new names). `'Hookups'` exists in NO inspection source — the assertions have been failing since S573 (present in git HEAD). Synced both to `'RV site'` to keep the suite green; **Subsystem 10 should confirm the agent tool's RV checklist coverage is otherwise correct.**
- **Duplicate portal test files (flagged, not deleted).** `routes/maintenancePortal.test.ts` (S348, narrower) and `routes/maintenance-portal.test.ts` (S391, "full slice, 100%") both cover `maintenance-portal.ts`; the S391 one supersedes the S348 one, and the near-identical names (hyphen vs camelCase) are a drift trap. Recommend consolidating to the S391 file after confirming superset coverage — left for Nic's call (test hygiene, not correctness).
- **Dead `Contractor` type (flagged).** `@gam/shared` `MaintenanceRequest.contractor?: Contractor` + the `Contractor` interface have no consumers (grep-clean; other "Contractor" hits are unrelated Books 1099 payroll). Legacy from the abandoned marketplace; harmless. Leave as the contractor-side stub placeholder or remove later.
- **schema.sql was behind HEAD.** The regen (after my migration) shows 6 uncommitted tables (auto_field_jobs, lease_notices, connect_instant_circuit, landlord_instant_margins, platform_transfer_intents, scheduled_lease_changes) — that's the accumulated **uncommitted** S578–S583 work (nothing's committed, per the sweep), not new drift. Expected; all lands at the final deploy.

## FILES TOUCHED (S585)
- **API:** `routes/maintenance.ts` (authz gate + rename), `services/notifications.ts` (dead branch removed), `services/agents/tools/assignMaintenanceRequest.ts` + `approveMaintenanceRequest.ts` (rename), `db/migrations/20260805200000_*.sql` (new; applied), `db/schema.sql` (regenerated).
- **Shared:** `packages/shared/src/index.ts` (`MAINTENANCE_PCT` 0.03→0.05 + doc; `contractorId`→`assignedTo`; "8%" comment fixed). **Rebuilt.**
- **Frontend:** landlord `MaintenancePage.tsx` (`req.contractorId`→`req.assignedTo`).
- **Tests:** `maintenance.test.ts` (+cross-landlord 403 test, rate pinned to constant, rename), `tools.test.ts` (rename mocks + 2 stale RV assertions), `dbHelpers.ts` (comment).

## TREE STATE
- Maintenance surface: **203/203 green** across maintenance.test / maintenance-portal.test / maintenancePortal.test / tools.test (`DB_NAME=gam_test`). tsc clean: api, landlord, shared.
- Migration `20260805200000` applied to dev gam; schema.sql regenerated (gam_test rebuilds from it via globalSetup). Nothing committed (sweep rule 2).

## NEXT SESSION SHOULD TARGET
1. **Subsystem 10 — Inspections** (in order). `INSPECTION_MASTER_CATALOG.md`, `services/inspectionChecklistResolver.ts`, `routes/inspections.ts`, the per-area photo gate, finalize→PDF→tenant Docs, `units.features`-filtered ~123-item catalog. Confirm the agent-tool inspection checklist coverage while there (the 2 RV assertions were just synced; verify the tool's real behavior). Memory [[gam-inspections-overhaul]].
2. Carry the sweep rules (nothing committed; one deploy at the very END).

## FINAL DEPLOY (at sweep end — NOT now)
`cd packages/shared && npm run build` → `cd apps/api && npm run build && launchctl kickstart -k gui/$(id -u)/com.gam.api`; verify :4000 + a login; rebuild frontends; THEN commit. GOTCHA: orphan on :4000 → EADDRINUSE (memory [[gam-prod-api-restart]]).

## RELEVANT MEMORIES
[[gam-maintenance-5pct-contractor-marketplace]] (updated S585: 5% sealed-bid board, in-house-only today, contractor stubbed, assigned_to rename), [[gam-cashier-role]] (staff perms), [[gam-inhouse-agents]], [[fix-what-you-find-no-deferring]], [[gam-test-db-guard]], [[gam-prod-api-restart]], [[gam-inspections-overhaul]] (for S10).
