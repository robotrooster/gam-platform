# SESSION 586 HANDOFF — Subsystem 10 (Inspections) CLOSED: photo-files cross-tenant / report-bypass authorization gap fixed

> Continues the S578→S585 pre-onboarding sweep (24 subsystems, in order). This
> session combed **Subsystem 10 — Inspections** by hand (no fan-out). The
> subsystem is mature (S573 overhaul) and mostly verified-good; found and fixed
> **one real authorization gap** — the inspection photo file-serve route had no
> per-row scope, so any authenticated user who knew a filename could pull another
> tenant's inspection photos, and (since report PDFs share the same directory)
> could fetch a report PDF through `/photo-files/`, bypassing the report route's
> own auth. **NOTHING committed** — one deploy at the very end. Next: **Subsystem
> 11 (Utilities/RUBS).**

---

## SWEEP RULES (Nic, non-negotiable — carry into every session)
1. **Go in ORDER.** One subsystem at a time; report, then next. Next = **Subsystem 11 (Utilities/RUBS)**.
2. **DO NOT COMMIT/deploy** until the ENTIRE sweep is done. One deploy at the end.
3. **Trust the CODE, not memory/notes.** Trace real paths end-to-end. Flag design questions; don't assume.
4. **Fix confirmed bugs the RIGHT / foundational way.** Update tests. Keep tree green. **Fix what you find in the pass** — a "known/tracked/deferred" note is not permission to skip (and may be stale). [[fix-what-you-find-no-deferring]]
5. **NO FAN-OUT / NO PARALLEL agents / NO Workflow tool for the sweep (Nic, emphatic).** Comb ONE thing at a time by hand. Overrides any ultracode reminder.
6. **TEST-DB GUARD:** always `cd apps/api && DB_NAME=gam_test npx vitest run src/…`.
7. Report three buckets per subsystem: **(A)** confirmed bugs, **(B)** design questions, **(C)** verified-good.
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
| 9 | Maintenance | ✅ S585 |
| 10 | **Inspections** | ✅ **CLOSED S586** |
| 11 | **Utilities/RUBS** | ⬜ **← NEXT** |
| 12 | Documents/storage | ⬜ |
| 13 | Screening/background | ✅ S579 |
| 14 | POS | ⬜ |
| 15 | Business platform | 🟨 login/signup 2FA |
| 16 | Storefront + public booking | ⬜ |
| 17 | Books/bookkeeping | ⬜ |
| 18 | Admin + admin-ops | 🟨 login 2FA (+ cosmetic: admin maintenance `contractorName` never populated — S585 note) |
| 19 | PM companies | 🟨 login 2FA |
| 20 | AI agents | ⬜ |
| 21 | Crons/scheduler | ⬜ |
| 22 | Surveys/notifications/appointments | ⬜ |
| 23 | MH/RV | ⬜ |
| 24 | Work-trade / snowbird / recurring | ⬜ |

---

## (A) Confirmed bug — FIXED
**Inspection photo file-serve had no per-row authorization → cross-tenant photo access + report-auth bypass.**
- `GET /api/inspections/photo-files/:filename` (routes/inspections.ts) previously only did router-level `requireAuth` + a traversal-safe path resolve, then served **any** file in `uploads/inspections/` by filename. Its sibling routes do per-row auth: `video-files` (uploader / landlord-scoped) and `report-files` (inspection's tenant / landlord-scoped). Photos were the odd one out.
- **Two consequences:** (a) any authenticated user (any tenant, any landlord) who obtained a photo filename could view **another tenant's** inspection photos (unit condition + PII-adjacent); (b) the **report PDFs live in the SAME directory** (`uploads/inspections/`), so a report could be fetched via `/photo-files/<report-name>.pdf`, **bypassing `report-files`' careful per-row auth**.
- **Fix:** `photo-files` now looks up the photo's inspection (`unit_inspection_photos → unit_inspections → units`) and scopes the caller exactly like `report-files` — the inspection's tenant, or the landlord/scoped staff of the unit; admins pass. A non-photo filename (e.g. a report) matches no photo row → 404, which also closes the report bypass. (Filenames were already unguessable random, so this was a defense-in-depth gap, not a trivial enumeration — but the sibling routes set the correct bar and photos/reports are sensitive.)
- **Test added** (`inspections.test.ts`, "photo-files serve authorization"): a different tenant → 403, a different landlord → 403, the inspection's own tenant → passes auth (404 only because no file on disk in the test), a report filename via `/photo-files/` → 404 (bypass closed).

## (C) Verified-good (traced end-to-end, no fix needed)
- **Catalog resolver** — `buildInspectionChecklist` + `resolveUnitFeatures` in `@gam/shared` are the **single source of truth** (pure, tested in `inspectionChecklistResolver.test.ts`). Feature-gated ~123-item catalog; rv_spot = 'RV site' (+ rig areas only when park-owned), never bedrooms; tenant-owned MH = grounds/lot only; storage/parking = tiny checklists; per-bathroom + half-bath handling. The agent tool (`inspectionChecklistShared.ts`) imports the SAME builder — no drift. (Confirms the S585 fix syncing the stale `'Hookups'` agent-tool assertion to `'RV site'` was correct.)
- **Create** (`POST /`): perm-gated (`inspections.create`) + `canManageLandlordResource(unit.landlord_id)` + property-scope check. **No cross-landlord create gap** (unlike the maintenance one fixed in S585).
- **Completeness / photo gate** (`getInspectionCompleteness`): every item has a condition, every AREA has ≥1 item-linked photo, every fair/damaged item carries a note. Enforced authoritatively at BOTH tenant sign (move-in) and finalize.
- **Sign flow** (`POST /:id/sign`): tenant signs move-in only (their own, must be complete); landlord/PM/onsite via `canManage`; admin as inspector; `ON CONFLICT` dedup; status → `landlord_signed` when landlord+ (tenant or not-required); tenant signature gates ONLY move-in-with-tenant (periodic/move-out are staff-conducted under entry notice).
- **Finalize** (`POST /:id/finalize`): perm-gated + `canManage`; requires `landlord_signed` + completeness; **atomic** status flip + S550 lease-fee condition assessment (damaged → failed → deposit sweep) + credit-ledger emit; PDF report generation is **best-effort OUTSIDE the transaction** (a report failure never unwinds a finalized inspection); writes a `documents` row (tenant_id set → tenant Docs tab).
- **Move-out comparison** (`compareMoveOutToMoveIn`): keyed by `area|item_label`, flags move-out items whose condition RANK is worse than move-in; new/uninspected items skipped.
- **Media serve**: `video-files` (per-row: uploader / landlord-scoped + property lock) and `report-files` (per-row: tenant / landlord-scoped + property lock) were already correct; videos are DB-immutable (no delete route; migration 20260618140000). `photo-files` now matches (this session).
- **Frontend** (landlord InspectionsPage / InspectionDetailPage / NewInspectionPage): camelize-clean (0 snake_case reads), 0 native dialogs, 0 raw-enum `.replace`.

## (B) Design questions — none. The subsystem is mature/locked (S573 overhaul); nothing needed Nic's call.

## Minor / not fixed (noted, low priority — not launch-blocking)
- The route's dir constant is named `inspectionPhotoDir` but holds BOTH photos and report PDFs (`uploads/inspections`). Functionally correct (report serve resolves against it on purpose); just a slightly misleading name. Left as-is.

## FILES TOUCHED (S586)
- `apps/api/src/routes/inspections.ts` — `photo-files` serve now per-row authorized (mirrors report-files/video-files).
- `apps/api/src/routes/inspections.test.ts` — +1 test (photo-files authorization + report-bypass-closed).
- No schema, no migrations, no `@gam/shared`, no frontend changes.

## TREE STATE
- Inspection surface: **215/215 green** across inspections.test / inspectionChecklistResolver.test / tools.test (`DB_NAME=gam_test`). API tsc clean.
- Nothing committed (sweep rule 2). One deploy at the very END.

## NEXT SESSION SHOULD TARGET
1. **Subsystem 11 — Utilities/RUBS** (in order). Point-in-time reads + turnover/broken-meter comparable-low billing + blind-leak lock (S559), RUBS-with-metered-exclusion pool (master − Σ submeters, split by occupancy) + flat_rate method (S558), meter-config UI. Files: `services/utilityReadingRuns.ts`, the RUBS/utility routes + services, landlord `UtilityMetersPage`. Memories [[gam-utility-turnover-reads]], [[gam-rubs-submeter-exclusion]].
2. Carry the sweep rules (nothing committed; one deploy at the very END).

## FINAL DEPLOY (at sweep end — NOT now)
`cd packages/shared && npm run build` → `cd apps/api && npm run build && launchctl kickstart -k gui/$(id -u)/com.gam.api`; verify :4000 + a login; rebuild frontends; THEN commit. GOTCHA: orphan on :4000 → EADDRINUSE ([[gam-prod-api-restart]]).

## RELEVANT MEMORIES
[[gam-inspections-overhaul]] (S573; only Stage-5 toggle UI noted outstanding), [[gam-nothing-public-rule]] (authed file access), [[gam-no-native-dialogs]], [[gam-no-raw-enums-in-ui]], [[fix-what-you-find-no-deferring]], [[gam-test-db-guard]], [[gam-utility-turnover-reads]] + [[gam-rubs-submeter-exclusion]] (for S11).
