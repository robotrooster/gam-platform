Session 56 Handoff — Migration runner + dev.sh wiring + schema.sql snapshot

Date: April 29, 2026

WHAT SHIPPED

Real database migration system. Replaces apps/api/src/db/migrate.ts (the old version ran the entire schema.sql on every boot and silently re-inserted platform singletons forever).

apps/api/src/db/migrate.ts (277 lines, replaces 39-line predecessor). Scans apps/api/src/db/migrations/ for files in lexical order. sha256 fingerprint per file. schema_migrations tracking table (filename PK, applied_at, checksum). Each unapplied file runs in its own transaction. Supports .sql and .ts files (TS files default-export an async function taking a PoolClient). Three CLI modes: default runs pending, --status shows state and exits non-zero on mismatches, --mark-applied <file> records a tracking row without executing the file (one-time bootstrap on a DB that already has the schema). Refuses to start when an applied migration's on-disk checksum no longer matches its tracked checksum — verified live by tampering and reverting.

Three migrations applied:
  20260429202524_initial_schema.sql — pg_dump of live DB at session start, marked applied (not executed, schema was already there).
  20260429203241_seed_platform_singletons.sql — INSERT ... ON CONFLICT DO NOTHING for reserve_fund_state and float_account_state. Defective — relied on PK collision against uuid_generate_v4 default, which never collides. Left in place per the no-edit-history rule.
  20260429203922_enforce_platform_singleton_uniqueness.sql — corrects the previous one. Collapses each table to one row, adds partial unique index on ((true)) to enforce singleton at the database level. Inserts of a second row now fail at the database with a unique constraint violation.

dev.sh rewired. set -e at top. Migration step inserted before app boot (npm run db:migrate). Failed migration prints clear error and exits without booting any app. Kill list extended to 3008 and 3009 (were missing). Duplicate apps/admin-ops launch line removed. Port map display corrected — removed stale PropIntel/PropAPI entries, added Listings and AdminOps which were being started but not advertised. Listening-ports verification now checks 3008/3009 too. Backed up at dev.sh.s29c2g.bak.

schema.sql neutralized. No longer source of truth — generated reference snapshot only. Header banner says DO NOT EDIT, points to migrations/ directory. Regenerated via scripts/dump-schema.sh (also new) which is invoked by npm run schema:dump. New schema.sql is 4993 lines, captures all 80 live tables including schema_migrations. Old schema.sql backed up at schema.sql.s29c2g.bak.

Workspaces config in root package.json cleaned. Was 5 entries (packages/*, apps/*, apps/pos, apps/listings, apps/admin-ops) — last three were redundant with apps/* wildcard. Now 2 entries. All 12 workspaces still resolve.

NEW STANDING RULES

S56-1: Migration files are immutable once applied. The runner enforces this via sha256 checksum at startup. To correct a mistake in an applied migration, write a new migration. Editing the original breaks startup until the file is restored byte-for-byte.

S56-2: Don't trust handoff claims about artifacts existing on disk. The S29c-2-E memory entry claimed a Python diff harness was "candidate for extraction" — verified S56, scratch dir contains only S29c-2-D parser-debug TypeScript files. The Python harness lived only in chat history, never landed. When a handoff references something on disk, ls it before planning around it.

S56-3: ON CONFLICT DO NOTHING does nothing when the conflict target is a UUID primary key with uuid_generate_v4 default. New UUID per insert means no collision possible. For singleton tables, enforce uniqueness via a partial unique index on a constant expression — CREATE UNIQUE INDEX ... ON tbl ((true)). Database refuses second insert structurally.

DEFERRED — pick foundation-first

Schema diff harness, fresh build at apps/api/scripts/diff-schema.ts. Compares INSERT/UPDATE column references in code against live DB via information_schema.columns. Pairs with the migration runner — runner catches edit-history bugs, harness catches code-vs-schema drift bugs. Concept proven in S29c-2-E (caught lease_pets.service_animal vs is_service_animal rename and leases.supersedes_lease_id missing). Does not exist on disk despite prior memory claim. Run before any session adding new write SQL. ~30-60 min.

Background check subsystem audit. NOT a 2-column add. Recon S56: tenants missing background_check_status + background_check_id (8 ref sites in routes/background.ts). background_checks table missing 6+ columns referenced by route code (decided_at, decision_notes, first_name, last_name, ssn_last4, tenant_id). CHECK constraint too narrow (rejects approved/denied that the route writes). application_pool and pool_match_requests existence unverified. Full subsystem audit, same rule as PM — no incremental fixes. One full session.

Properties endpoint $9 placeholder + missing amenities column audit. PATCH /api/properties/:id has $9 used twice (unit_types AND amenities), and amenities column doesn't exist in the properties table — silently no-ops. Full properties audit session.

PM subsystem. apps/api/src/routes/pm.ts references nonexistent tables pm_companies, pm_fee_plans, and nonexistent columns. Either full build or rip pm.ts entirely. No incremental fixes.

GAM Books AZ tax logic genericization. apps/api/src/routes/books.ts contains hardcoded AZ A1-QRT, AZ A1-R quarterly withholding forms and AZ flat-rate logic. Either genericize with state-aware lookups or scope-lock as AZ-only with explicit disclaimer.

Master Schedule finish-or-strip. SchedulePage.tsx + GET /units/schedule/master + 8 stub columns on units + empty unit_bookings table. No booking flow UI exists.

ReportsPage endpoint build. ReportsPage.tsx calls GET /api/reports/summary which doesn't exist. Page renders empty dashes. Needs endpoint design (collected MTD, outstanding balance, occupancy, monthly rollup, PM vs landlord splits) + build.

S23d Tier 1 CHECK migrations. 11 of 14 still pending the next infra session.

Two parallel email systems consolidation. services/email.ts (Resend) vs lib/email.ts (nodemailer). Single system, single sender.

Notifications schema rebuild. Dead notification types still listed in NotificationBell and tenant notification preferences (lease_expiring_60, lease_expiring_30, lease_renewal_survey from pre-S18 scheduler).

Source PDF path resolution rebuild. Currently split('/').pop() — fragile.

E-sign /files/:filename auth gap. /files/:filename is open to anyone; the equivalent /me/pending-tenants/:intentId/document is auth-gated.

POST /sign/:documentId transaction wrap. Multi-statement writes without atomicity.

POST /esign/documents reject executionFailed docs. Missing status guard parallel to the platform block.

Void cascade switch → shared helper. Duplicated across e-sign routes.

pdf.js loader extraction. Duplicated 6 sites, candidate for shared module.

Witness in send modal.

Tenant draft persistence (in-progress signing state).

Tenant decline path with reason + landlord notification.

Tenant view-only re-open of executed/in-flight docs.

Movie-font signature styles → professional fonts.

Initials lock-to-name (low-priority edge case).

Three backup files cleanup in routes/ (s19backup, s20backup, s21backup).

Permission gating audit across landlord portal (every screen + route needs role+scope filtering).

Short-term booking acknowledgment docs on unit_bookings.

Payment-method surcharge passthrough at property level.

Consolidated landlord-side ACH pull optimization.

Guarantor/cosigner billing flow.

Flex Suite reintroduction (post-capital, post-legal review).

Property late-fee edit confirmation modal (with addendum/notice-period reminder).

Lease-change addendum workflow with legal notice timing.

Deposit interest accrual engine.

Landlord disbursement engine that nets tenant-owed deposit interest from monthly payouts.

leases.security_deposit deprecation into lease_fees.

S26a catch-up window admin endpoint (POST /admin/invoices/backfill, date range + dry-run).

lease_fees.due_timing='move_out' and 'other' not consumed by any generator yet.

Email-failure surface to landlord UI. Spans /commit and inherits through /onboard-tenant-pending and /resolve when activation email lands at resolve time.

Punch-list-resubmit limbo dispatch. Today, fixing identity blockers in the punch list and resubmitting goes through /commit, which still rejects rows with lease blockers. Pure-lease-blocker rows after fix should go to limbo automatically.

5 broken bookkeeper endpoints in routes/books.ts.

routes/utility.ts dormant + has SQL injection.

Empty stub utility tables in live DB.

ConfirmIntentModal noUnusedLocals strict-mode hygiene pass on landlord (~20 hits across Layout, NotificationBell, BackgroundChecksPage, DashboardPage, DisbursementsPage, DocumentsPage, InviteTenantModal, LeasesPage, LoginPage, plus likely more downstream).

End-to-end /resolve smoke including landlord-overridden entity rows. With entity arrays now sendable from S29c-2-F UI, resolveIntent's writers face fresh shape — landlord-added rows that never went through parser. Watch points: JSONB serialization round-trip on parser_output and parser_flags, PDF promotion (rename pending → leases dir), emailTenantOnboarded signature match (logged-not-fatal so could be silent), activation URL formatting matches activation page expectations, shape errors at resolveIntent's writers on rows that bypassed parser shaping.

Sublease subsystem full build.

Cross-platform audit trail validation.

Tenant-pool endpoint.

Platform-specific CSV import mappings (Buildium, AppFolio, DoorLoop, Yardi, RentManager, Propertyware, Rentec Direct, TenantCloud + 1-2 TBD).

Tenant-pool picker + unit picker with consent rule.

5 of 8 npm audit vulnerabilities (nodemailer pending email consolidation; uuid via node-cron + svix + resend pending major-version session).

Team UI rebuild (single team_member_scopes table).

NUMBERING

Real session count = total chat count with Claude. S56 = 56 chats. Historical session numbers in old handoffs and git commit messages (S6 through S29c-2-F) don't match real count and aren't being reconciled. Future sessions are clean increments from chat count. Next is S57. No letters, no sub-prefixes.

CLOSED THIS SESSION (removed from deferred list)

schema.sql full regen + migrate.ts rewrite.
dev.sh admin-ops duplicate line.
Workspaces config redundancy in root package.json.

End of S56 handoff.
