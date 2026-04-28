Session 29c-2-A Handoff — Tenant Onboarding, Punch List + Limbo Backend

Date written: April 28, 2026
Branch: main (everything uncommitted — Nic handles git locally)
Schema: schema.sql + ad-hoc DB ALTERs (see SCHEMA DRIFT below — pre-existing bug surfaced this session, not fixed)
TSC baseline: 0 / 0 / 0 (api / shared / landlord)
API boot: not booted this session

SESSION PURPOSE

Continue the existing-tenant onboarding frontend started in S29c-1. Original plan was punch-list editor plus single-tenant manual form plus entry-point buttons plus invite audit. Architecture pivot mid-session reshaped the single-tenant path entirely — manual data entry beyond name/email/phone was deemed wrong product design (more on this in ARCHITECTURE PIVOT below). What landed instead: punch list, entry points, locked limbo architecture documented, limbo backend rails built.

ARCHITECTURE PIVOT — read this first

The original plan had a single-tenant manual form where the landlord types name, email, phone, picks a unit, types lease terms (start, end, rent, deposit, late fee, auto-renew mode, notice days), submits. This was wrong. Why:

The lease document is the source of truth for unit assignment, rent, dates, and parties. Asking the landlord to retype data that already exists on a paper lease is busywork and an error source. The right shape:

Landlord types only name, email, phone. Tenant lands in a pending pool — user row plus tenant row plus intent row exist, no lease, no email_verify_token, no activation email. Landlord uploads the lease PDF onto the pending tenant. PDF parser (separate workstream) extracts unit, lease terms, parties. Parser flags anything that smells wrong: name/email mismatch (wrong file), unit not found in portfolio, missing fields, suspect values (rent zero, dates 50 years out), low-confidence extractions. Landlord confirms or fixes flags; system creates the lease, links lease_tenants, fires the activation email.

Three on-ramps converge on the same lease-creation moment:

1. Bulk CSV with full data — commits straight through (S29c-1 plus this session).
2. Bulk CSV with missing lease fields — rows route to limbo instead of erroring (S29c-2-B).
3. Single-tenant manual — name/email/phone only, then PDF (this session backend, frontend in S29c-2-B).

Locked decisions:

No manual lease-term entry beyond name/email/phone. Ever.

Activation email fires only at lease creation, not at limbo entry. No half-state where a tenant signs in to an empty portal.

Async parser. Upload returns immediately, parser runs in the background, landlord polls or refreshes to see status.

Mismatch flags are categorized (identity_mismatch, unit_not_found, field_missing, field_suspect, field_low_confidence) with severity (block vs confirm). UI renders accordingly.

Pending intents deletable in any unresolved state. Cleanup cascades to user and tenant if no other refs exist.

WHAT SHIPPED — FRONTEND

Bulk CSV punch list with fast-path commit. File: apps/landlord/src/pages/TenantOnboardingPage.tsx. After /validate returns, frontend splits rows into clean unit-groups (fast-path commits immediately) and dirty unit-groups (any row has a blocker, goes to punch list).

Fast-path commits clean unit groups in a single bulk /commit call. Green banner shows count of tenants and units onboarded. Fast-path failure is graceful: rolls all rows into the punch list and surfaces the error.

Punch list renders per-unit cards (one card per unit, tenants stacked). Lease section at top with editable fields (start, end, rent, deposit, late fee, late fee grace days, auto-renew toggle plus mode dropdown, notice days). Tenant rows below with first/last name, email, phone. Block-severity issues highlight red, warn-severity yellow, messages below each field.

Per-card actions: Make-primary on co-tenant rows, Remove on any tenant row (if unit has more than one tenant), Submit. Submit sends only that unit's rows to /commit; on success, card unmounts and queue shrinks. Submission failures show the backend error inline without dropping landlord's edits.

Issue-clearing on edit: editing a field strips that field's issues from the row's issues array (using FIELD_TO_ISSUE_KEY map for camelCase / snake_case translation). Backend re-validates on commit so this is purely UI feedback.

Email-edit edge case handled: when landlord changes a row's email, resolvedExistingUserId and resolvedExistingTenantId are stripped from that row, since the resolution is now stale. Backend will INSERT a fresh user; if the new email collides with an existing user the unique constraint surfaces a clear error.

Single-tenant placeholder. Mode 'single' on /tenant-onboarding shows an honest "coming soon" card describing the PDF-driven flow. Tells landlord to use Bulk CSV for now. Replaces what was originally going to be a 200-line manual form.

Entry-point buttons. On TenantsPage.tsx: "Onboard Existing Tenant" button (UserPlus icon, btn-ghost) next to "Invite Tenant" (btn-primary) in the page header. Hierarchy: Invite is the new-tenant signing flow (primary), Onboard is the migration flow (secondary).

On UnitDetailPage.tsx: "Onboard Existing Tenant" button (btn-sm btn-primary) inserted before "Mark Available" in the vacant-block action bar. On a vacant unit, onboarding is the most likely action.

/tenants/invite call-site audit (item 5 of original plan). Two call sites total: ESignPage.tsx line 451 (known offender, e-sign send modal, replacement is S29d's item 7) and InviteTenantModal.tsx line 24 (legitimate invite modal, stays). Audit done, no code changes here, just enumerated.

WHAT SHIPPED — BACKEND (LIMBO RAILS)

Table pending_tenant_intents. Columns: id, landlord_id, tenant_id, parser_status (CHECK in not_uploaded/parsing/parsed/mismatch/error/resolved), imported_pdf_url, parser_output (JSONB), parser_flags (JSONB array), parser_error, parser_started_at, parser_finished_at, resolved_at, resolved_lease_id, created_at, updated_at, UNIQUE (tenant_id).

Two partial indexes: idx_pending_tenant_intents_landlord for the landlord's unresolved queue, idx_pending_tenant_intents_parser_status for the parser worker (when it lands). FKs cascade to landlord and tenant, SET NULL to leases. Applied to live DB and appended to schema.sql in the same paste.

Endpoints, all under landlordsRouter in apps/api/src/routes/landlords.ts:

POST /me/onboard-tenant-pending. Body: firstName, lastName, email, phone. Creates user (no email_verify_token, no email send), tenant (onboarding_source='onboarded'), intent (parser_status='not_uploaded'). Three pre-flight rejects: cross-landlord active lease (409), same-landlord active lease (409), same-landlord pending intent already exists (409). Reuses existing user/tenant rows when found.

GET /me/pending-tenants. List of unresolved intents for this landlord, joined to user info. Returns intentId, tenantId, userId, email/firstName/lastName/phone, parserStatus, importedPdfUrl, parserFlags, parserError, timestamps.

DELETE /me/pending-tenants/:intentId. Full cleanup. Deletes intent always. Deletes tenant and user only if no other refs (no other lease_tenants links, no other pending intents). PDF file unlinked from disk. Resolved intents are off-limits to DELETE — audit trail stays intact.

POST /me/pending-tenants/:intentId/document. Multipart with field name 'file', PDF only, 20MB max. Stores PDF in uploads/lease-pdfs-pending/, transitions intent to parser_status='parsing', kicks off parser stub. Allowed states for upload: not_uploaded, error, mismatch (re-upload after bad attempt). Re-upload deletes the previous PDF.

GET /me/pending-tenants/:intentId/document. Streams PDF back to owning landlord only. Auth-gated, unlike e-sign's /files/:filename which is open to anyone with the filename.

Parser stub. schedulePendingParserStub(intentId). 2-second setTimeout flips intent to parser_status='error' with a clear message ("Parser not yet implemented. PDF stored, ready for S29c-2-C parser session."). Lets the UI demonstrate the upload, spinner, and error flow end-to-end without the real parser. When the real parser lands, this function gets ripped and replaced with a real worker invocation (probably enqueuing onto the same job runner pattern as jobs/scheduler.ts).

SCHEMA DRIFT — pre-existing bug surfaced this session

The repo has no migrations directory and no migration numbering. There's a single apps/api/src/db/schema.sql that gets applied idempotently by migrate.ts (CREATE TABLE wrapped in "ignore 42P07 already exists" handling).

S29c-1 added columns to existing tables (tenants.onboarding_source, tenants.platform_status, leases.lease_source, leases.imported_pdf_url, leases.needs_review, units.unit_type, plus more). These were applied as ad-hoc ALTERs against the running DB but never written back to schema.sql. Verified this session: live DB has the columns, schema.sql does not.

Implication: npm run migrate against a fresh DB today produces a schema missing every column S29c-1 added. routes/landlords.ts INSERT INTO tenants with onboarding_source would fail. New developer onboarding broken.

This is not S29c-2-A's bug to fix. It's a dedicated session: diff live DB schema against schema.sql, back-fill every missed ALTER as ALTER TABLE ADD COLUMN IF NOT EXISTS in schema.sql, verify a fresh migrate produces a working DB. Added to deferred list.

The standing pattern going forward (until this is fixed properly): every schema change is applied to BOTH the live DB AND schema.sql in the same paste. This session followed that pattern for pending_tenant_intents.

The earlier handoff line "Migrations applied: 001-009" was wrong — there is no migration numbering. The user memory should be updated to reflect reality.

WHAT'S QUEUED FOR S29C-2-B (NEXT SESSION)

In suggested build order:

1. CSV /commit extension for limbo routing. Currently /onboard-tenants-csv/commit errors if any row has block-severity issues. Extend: rows missing lease-only fields (rent, dates) but with valid name/email/phone route to limbo (create user plus tenant plus intent) instead of erroring. Rows with name/email blockers still error. Banner on the punch list summary: "X tenants routed to pending pool — upload their lease PDFs to complete onboarding."

2. Single-tenant manual form. Replaces the placeholder. Form has only firstName, lastName, email, phone. Submit calls POST /me/onboard-tenant-pending. Success state shows "Tenant added to your pending pool. Upload their lease PDF here or from the pending list." with a direct PDF upload box. Optional shortcut: upload PDF immediately after typing name/email so a landlord onboarding one-by-one doesn't need two steps.

3. Pending pool list page. New route /tenant-onboarding/pending (or surface inline on the main /tenant-onboarding mode picker as a third card showing pending count). Lists pending intents from GET /me/pending-tenants. Per-row: name, email, phone, parser status badge (color-coded), action buttons (Add document, Re-upload, View parser flags, Delete). Polls every 5 seconds while any row is in parser_status='parsing'.

4. Resolve flow UI. Once parser_status is 'parsed' or 'mismatch', landlord clicks into a per-row detail. Side-by-side: what landlord typed vs what parser extracted. Each flag rendered with its severity (block vs confirm). Landlord either confirms each flag (overrides the warning) or rejects the PDF (re-upload). When all blockers cleared, "Build lease" button calls a new endpoint POST /me/pending-tenants/:intentId/resolve (S29c-2-C — see below).

S29C-2-C AND BEYOND

POST /me/pending-tenants/:intentId/resolve. Landlord-driven lease creation from intent plus parser output plus landlord overrides. Builds the lease, inserts lease_tenants link, sets email_verify_token, fires emailTenantOnboarded, marks intent parser_status='resolved' with resolved_lease_id and resolved_at. Promotes the PDF from uploads/lease-pdfs-pending/ to uploads/leases/ and sets leases.imported_pdf_url.

The parser itself. Separate workstream. Whatever PDF parsing strategy lands (in-house ML, regex-based extraction, hybrid) plugs in by replacing schedulePendingParserStub with a real invocation. Output shape is already defined: parser_output (JSONB) is the full extracted record, parser_flags (JSONB array) is the flag list. Status transitions to 'parsed' (no blockers), 'mismatch' (blockers present), or 'error' (parse failed entirely).

Per the standing rule — no third-party AI APIs for core data — the parser must run on GAM infrastructure when it lands.

STANDING COMMANDMENTS — additions from this session

(Earlier S29c commandments unchanged: engineering 10 commandments, single source of truth, no state-specific legal logic, no third-party AI APIs, no timezone-specific defaults, recon-first, ask scope-shaping, one targeted fix at a time, ~50% context for handoff, no emojis, set +H first, plain-language options, anchor strings via raw file reads, push back when deferred-list framing is wrong, fast turnarounds, two-flow architecture, imported leases as first-class objects, lease re-signing as only renewal path, validate plus commit two-endpoint pattern, large paste-blocks split, cosmetic markdown auto-linking, Apple Terminal Smart Links, recon includes grep for filenames about to create, per-unit commit not per-row, CSV download via raw fetch.)

NEW from S29c-2-A:

The lease document is the source of truth, not the landlord. Anywhere we ask the landlord to type data that already exists on a paper document, we are creating busywork and error surface. The right architecture asks the landlord for only the things the document doesn't contain (their intent — "this person is a tenant of mine") and lets the document drive the rest. This applies to onboarding now, will apply to lease amendments and renewals later.

Activation email fires only when a tenant has a real place to land. Sending an activation email to a tenant whose unit/lease/rent isn't established yet creates a confused first experience. Keep limbo landlord-side only. The tenant's first contact with GAM should already have full unit plus rent plus lease context.

Async by default for any work that could take more than a second. Sync feels nice for small datasets; it breaks at scale. The cost of building async right the first time is small (one setTimeout-equivalent plus a status column plus UI polling) versus the cost of rebuilding sync to async later. This applies beyond the parser — anywhere we touch external services, file processing, or batch operations.

Plain-language option presentation. When asking Nic to choose between architectural options, frame each option in plain English with the tradeoffs spelled out, not technical jargon. The technical schema is implementation; the choice belongs to the product.

Schema drift is a real recurring problem. Until the schema-drift session lands and back-fills schema.sql properly, every schema change must be applied to BOTH the live DB AND schema.sql in the same paste. No exceptions.

Handoffs are plain text. No code fences, no bullet markdown, no nested formatting. Sections separated by capital-letter headings, run-on prose with sentence-level structure. Landlord-readable.

FILES CHANGED

apps/api/src/db/schema.sql — appended pending_tenant_intents block at end.
apps/api/src/routes/landlords.ts — 4 new endpoints, multer config, parser stub.
apps/landlord/src/pages/TenantOnboardingPage.tsx — rewritten to add punch list and fast-path commit, single-tenant placeholder.
apps/landlord/src/pages/TenantsPage.tsx — Onboard button added.
apps/landlord/src/pages/UnitDetailPage.tsx — Onboard button added to vacant block.

Live DB: pending_tenant_intents table created with 2 partial indexes, 6 CHECK values, 1 UNIQUE constraint, 3 FKs.

Suggested commit message:

S29c-2-A: tenant onboarding punch list plus limbo backend rails. Frontend: bulk CSV punch list per-unit cards with fast-path commit, single-tenant placeholder pointing at limbo flow, entry-point buttons on Tenants and UnitDetail. Backend: pending_tenant_intents table (live plus schema.sql); POST /me/onboard-tenant-pending creates user/tenant/intent with no email; GET /me/pending-tenants lists landlord queue; DELETE /me/pending-tenants/:intentId conditional cascade cleanup; POST /me/pending-tenants/:intentId/document multer-backed PDF upload with parser stub; GET /me/pending-tenants/:intentId/document auth-gated download. Parser stub flips to error 2s after upload pending S29c-2-C real parser. Architecture pivot documented: lease PDF is source of truth, manual entry limited to name/email/phone, activation email fires only at lease creation, async-by-default.

SMOKE TEST PASTE-BLOCK (for whenever Nic is ready to walk this)

set +H
cd ~/Downloads/gam
./dev.sh

Walk 1 — punch list end-to-end (frontend already shipped, never smoke-tested). Browser, log in as realestaterhoades@gmail.com / landlord1234. Tenants page, confirm "Onboard Existing Tenant" button next to "Invite Tenant". Click it, /tenant-onboarding lands on mode picker. Click "Bulk CSV Import", 3 step cards. Download template, fill 2 rows for the same unit (1 clean, 1 with bad email). Upload, click Validate. Confirm: validation summary stat tiles, punch list card for the dirty unit, red border on bad email field, error message below it. Fix the email inline, click "Onboard this unit". Confirm card flashes green then unmounts. Walk 1 also covers fast-path: if you upload a CSV where the entire unit is clean, you should see green "X tenants onboarded" banner and no punch list.

Walk 2 — limbo backend smoke (no UI yet, curl-only).

TOKEN=$(curl -s -X POST http://localhost:4000/api/auth/login -H 'Content-Type: application/json' -d '{"email":"realestaterhoades@gmail.com","password":"landlord1234"}' | python3 -c 'import json,sys;print(json.load(sys.stdin)["data"]["token"])')

curl -s -X POST http://localhost:4000/api/landlords/me/onboard-tenant-pending -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"firstName":"Test","lastName":"Tenant","email":"limbo-smoke@example.com","phone":"5555550100"}' | python3 -m json.tool

curl -s http://localhost:4000/api/landlords/me/pending-tenants -H "Authorization: Bearer $TOKEN" | python3 -m json.tool

INTENT_ID=<paste-from-create-response>
curl -s -X POST http://localhost:4000/api/landlords/me/pending-tenants/$INTENT_ID/document -H "Authorization: Bearer $TOKEN" -F "file=@/path/to/any.pdf" | python3 -m json.tool

sleep 3
curl -s http://localhost:4000/api/landlords/me/pending-tenants -H "Authorization: Bearer $TOKEN" | python3 -m json.tool

(re-upload allowed because parser_status='error')
curl -s -X POST http://localhost:4000/api/landlords/me/pending-tenants/$INTENT_ID/document -H "Authorization: Bearer $TOKEN" -F "file=@/path/to/another.pdf" | python3 -m json.tool

curl -s -X DELETE http://localhost:4000/api/landlords/me/pending-tenants/$INTENT_ID -H "Authorization: Bearer $TOKEN" | python3 -m json.tool

curl -s http://localhost:4000/api/landlords/me/pending-tenants -H "Authorization: Bearer $TOKEN" | python3 -m json.tool

ls -la uploads/lease-pdfs-pending/ (should not contain the deleted file)

CARRIED-FORWARD DEFERRED LIST

Cleared this session: Frontend punch list editor plus fast-path commit (handoff item 1, 2 from S29c-2-A original plan). Entry-point buttons on Tenants and UnitDetail (item 4). /tenants/invite audit (item 5). Limbo backend rails: table, 4 endpoints, parser stub.

Newly added in S29c-2-A:

Schema drift bug. Pre-existing from S29c-1. Live DB has columns schema.sql doesn't. Dedicated session needed to diff and back-fill. High priority because new-developer onboarding is broken until then.

E-sign /files/:filename auth gap. GET /api/esign/files/:filename serves any PDF to anyone with the filename. Pending-intent PDF endpoint fixed this for its own files but the e-sign hole remains. Same dedicated session probably.

Real PDF parser implementation. Replaces schedulePendingParserStub. In-house only per standing rule. Output shape is locked (parser_output JSONB plus parser_flags JSONB array).

POST /me/pending-tenants/:intentId/resolve. Landlord-driven lease creation from intent plus parser output plus overrides. Promotes PDF from uploads/lease-pdfs-pending/ to uploads/leases/.

Pending-pool UI page (S29c-2-B item 3) and resolve flow UI (item 4).

CSV /commit extension for limbo routing (S29c-2-B item 1).

Single-tenant manual form (S29c-2-B item 2).

Email-failure surface to landlord UI. Now spans /commit (S29c-1) and /onboard-tenant-pending will inherit when activation email lands at resolve time. Should appear in onboarding history / dashboard so landlord can resend or share the URL directly.

From S29c — still active:

Tenant-pool endpoint — trivially buildable on top of tenants.onboarding_source. Single query returning onboarded plus applied tenants scoped to landlord. Slated for S29d alongside S29b item 7.

Platform-specific CSV import mappings (Buildium, AppFolio, DoorLoop, Yardi, RentManager, Propertyware, Rentec Direct, TenantCloud, plus 1-2 more TBD by Nic). Pure additive: extends source param dispatch plus adds per-platform column-name translation table.

tenants.background_check_status / background_check_id columns missing but routes/background.ts writes to them. UPDATEs silently throw, swallowed by next(e). BG status lives correctly on background_checks table directly. Dedicated session: add columns plus backfill, OR rip the stale UPDATEs and audit downstream readers.

5 of 8 npm audit vulnerabilities (nodemailer pending email consolidation; uuid via node-cron plus svix plus resend pending major-version session for node-cron).

From S29b — still active:

Item 7: tenant-pool picker (no free-text email) plus unit picker with consent rule plus backend enforcement on POST /esign/documents. Now unblocked by onboarding rails — onboarding turns existing tenants into real tenant records that the picker can pull from.

Backend enforcement: POST /esign/documents rejects occupied-unit sends without full active-tenant roster.

Extract void cascade switch into shared helper (currently duplicated between routes/esign.ts manual void and jobs/scheduler.ts auto-void).

Wrap POST /sign/:documentId in transaction.

POST /esign/documents should also reject executionFailed docs.

From earlier sessions — still active:

Notifications schema rebuild (its own dedicated session per Nic).

Witness in send modal.

Tenant draft persistence (autosave fieldValues to server) — loses progress on tab close today.

Tenant decline path with reason plus landlord notification.

Tenant view-only re-open of executed/in-flight docs.

Movie-font signature styles to professional fonts (branding decision).

Two parallel email systems consolidation (services/email.ts Resend vs lib/email.ts nodemailer).

3 backup files cleanup (s19backup, s20backup, s21backup in routes/).

Source PDF path resolution rebuild (currently split('/').pop() — fragile against future storage backend changes).

Initials lock-to-name (low priority edge case).

Properties endpoint $9 placeholder plus missing amenities column.

PM subsystem (full build or rip pm.ts).

GAM Books AZ-specific tax logic genericization.

Master Schedule finish-or-strip.

ReportsPage endpoint build (GET /api/reports/summary).

Team UI rebuild (single team_member_scopes table).

S23d Tier 1 CHECK migration: 11 of 14 still pending Session B.

Permission gating audit across landlord portal.

Short-term booking acknowledgment docs on unit_bookings.

Payment-method surcharge passthrough at property level.

Consolidated landlord-side ACH pull optimization.

Guarantor/cosigner billing flow.

Flex Suite reintroduction (post-capital, post-legal review).

Property late-fee edit confirmation modal with addendum/notice-period reminder.

Lease-change addendum workflow with legal notice timing.

Deposit interest accrual engine.

Landlord disbursement engine that nets tenant-owed deposit interest.

leases.security_deposit cleanup (move to security_deposits — NOT lease_fees).

S26a catch-up window admin endpoint (POST /admin/invoices/backfill).

lease_fees.due_timing='move_out' and 'other' not consumed by any generator yet.

Branch hygiene: feature/gam-books deletion/rename.

Smoke walk full lease build chain end-to-end — finally runnable after onboarding lands a tenant in the pool.

TSC rot from S19: admin.ts AppError import (3 sites), announcements.ts pool import, auth.ts @gam/shared rootDir plus missing query, background.ts vision unknown access errors, fitness.ts AuthRequest vs AuthPayload, units.ts:395 .id on AuthPayload. Boots via tsx tolerance.

End of S29c-2-A handoff.
