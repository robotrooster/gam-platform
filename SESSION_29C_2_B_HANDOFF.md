Session 29c-2-B Handoff — Tenant Onboarding Limbo Frontend + CSV Limbo Routing

Date written: April 28, 2026
Branch: main (uncommitted — Nic handles git locally)
Schema: no changes this session. Schema drift bug from S29c-2-A still unfixed.
TSC baseline: 0 / 0 / 0 (api / shared / landlord)
API boot: not booted this session

SESSION PURPOSE

Build out the limbo frontend (pending pool list, single-tenant form, mode picker integration) on top of the backend rails shipped in S29c-2-A. Plus extend CSV onboarding to route lease-only-blocker rows into limbo instead of erroring. Five pieces shipped, all in build order Option A (pool list spine first).

ARCHITECTURE PIVOT — carryforward from S29c-2-A

The lease document is the source of truth. Landlord types only name, email, phone. Tenant lands in a pending pool — user row plus tenant row plus intent row exist, no lease, no email_verify_token, no activation email. PDF parser (separate workstream, S29c-2-C+) extracts the rest. Activation email fires only at lease creation. Async by default.

S29c-2-B did not change any of that. It built the UI surface that lets the landlord interact with intents the backend already supports.

WHAT SHIPPED — SHARED TYPES (single source of truth)

packages/shared/src/index.ts grew by ~95 lines. Five exports plus types and runtime guards:

PARSER_STATUSES const array (not_uploaded/parsing/parsed/mismatch/error/resolved) — values match the live DB CHECK constraint exactly. ParserStatus type derived from the array.

PARSER_STATUS_META — record mapping each status to label, tone (muted/amber/green/red/gold), description. Drives badge rendering and tooltip text. UI imports from here so the metadata is one place.

PARSER_FLAG_CATEGORIES const array (identity_mismatch/unit_not_found/field_missing/field_suspect/field_low_confidence). ParserFlagCategory type derived. PARSER_FLAG_CATEGORY_META record with label and description per category.

PARSER_FLAG_SEVERITIES const array (block/confirm). ParserFlagSeverity type derived. No metadata map — severity is rendered by color and icon, not text.

ParserExtractedField<T> generic — { value, confidence, rawText? }. The shape one extracted field takes. Used to compose ParserExtractedTenant, ParserExtractedUnit, ParserExtractedLease.

ParserOutput type — full record the parser writes to pending_tenant_intents.parser_output (JSONB). Has tenants array, unit, lease, parserVersion, parsedAt. Field names inside lease section match the existing CSV row shape so resolve-time mapping is trivial.

ParserFlag type — single flag emitted by the parser. category, severity, optional field (dot-path), message, optional expected/found pair (for mismatch flags). Written to pending_tenant_intents.parser_flags (JSONB array).

isParserStatus, isParserFlagCategory, isParserFlagSeverity runtime guards for write-side validation.

Locks the contract before the parser ships. The real parser plugs into these types in S29c-2-C+; UI was built and ready against the locked shape.

WHAT SHIPPED — LANDLORD ROUTER + MODE PICKER

apps/landlord/src/main.tsx — import { PendingTenantsPage } from './pages/PendingTenantsPage' added after TenantDetailPage. Route <Route path="tenant-onboarding/pending" element={<PendingTenantsPage />} /> added directly under the parent /tenant-onboarding route.

apps/landlord/src/pages/TenantOnboardingPage.tsx — mode picker grew from 2 columns to 3. Third card "Pending Pool" with Inbox icon and amber badge showing count when pendingCount > 0. Click navigates to /tenant-onboarding/pending. Static count fetched once on mount with staleTime 30s — mode picker is a navigation surface, not a working surface; landlord clicks in for live state.

WHAT SHIPPED — PENDING POOL PAGE (657 lines new)

apps/landlord/src/pages/PendingTenantsPage.tsx. Six top-level functions: StatusBadge, PdfViewerModal, DeleteConfirmModal, FlagsDetail, IntentCard, PendingTenantsPage.

StatusBadge reads PARSER_STATUS_META and renders a className badge badge-{tone} with the label and description as title. Drift-proof against future status additions.

PdfViewerModal is a 5th instance of the pdf.js loader pattern — lifted from tenant LeasePage. Loads pdf.js from cloudflare CDN on demand, calls getDocument with httpHeaders Authorization Bearer plus localStorage gam_token, renders to canvas page-by-page with prev/next pagination when total > 1. Uses existing modal-overlay/modal classes from UnitDetailPage. Cleans up render task on unmount. Surfaces load errors inline with a danger color.

DeleteConfirmModal — clean confirm dialog for the cascade delete. States plainly that pending tenants have nothing downstream so delete is safe. Confirm button is danger-styled (#dc2626).

FlagsDetail — renders parser_flags grouped by category with blockers first within each. Three states: error (parser_status=error, surfaces parser_error string), empty flags (parsed cleanly), populated. Each flag card shows severity badge (Blocker/Confirm), field path (monospace), message, and side-by-side You typed / Parser saw blocks when expected/found are present.

IntentCard — single row in the pool list. Status badge, contact info, conditional action buttons. Action set: Upload document (status=not_uploaded), Re-upload (status=error or mismatch), View PDF (when importedPdfUrl exists and not parsing), Open/Close (toggles inline detail when status=parsed or mismatch), Delete (any non-busy state). Inline error preview when status=error and not expanded so landlord sees what went wrong without opening. Expanded detail renders FlagsDetail plus a Build lease button that is disabled with title "Available in next release" — points at the unbuilt resolve endpoint.

PendingTenantsPage — top-level page. Stop-when-idle polling: refetchInterval returns 5000 if any row is parsing, false otherwise. React-query then idles until something else invalidates. Hidden file input shared across all rows for upload/re-upload (multipart with explicit Content-Type override since the axios instance defaults to application/json which would prevent boundary detection). PDF size cap 20MB and PDF mime-type check happen client-side; backend re-validates. Empty state, error state, loading state all rendered. Mutations invalidate both pending-tenants and pending-tenants-count queries so the mode picker badge updates.

WHAT SHIPPED — SINGLE-TENANT FORM (~165 lines)

TenantOnboardingPage.tsx gained a new SingleTenantMode component, replacing the previous "coming soon" placeholder card. Two states:

Form state — four inputs (firstName, lastName, email, phone), all required, autoFocus on first. Native HTML form with onSubmit handler — native validation works, native enter-to-submit works. Submit calls POST /me/onboard-tenant-pending. Backend 409 messages surface directly in an inline error banner: cross-landlord active lease, same-landlord active lease, duplicate pending intent. Inline AlertCircle + colored border on the error banner; landlord sees exactly which conflict hit them.

Success state — checkmark icon, "X added to pending pool" headline, optional inline PDF upload (same multipart pattern as the pool list page), three exit paths: Upload lease PDF (primary), Add another (clears form), View pending pool (navigates to /tenant-onboarding/pending). After successful upload, navigates straight to pending pool — landlord sees the tenant they just created with the just-uploaded PDF in error or parsed state once the parser stub flips it.

Defensive shape handling — the success response is normally { success, data: { intentId, ... } }, but the form falls back to intent_id / null if intentId is missing. If null, the inline upload button is replaced with "Go to Pending Pool to upload" so the landlord still has a forward path.

WHAT SHIPPED — CSV LIMBO ROUTING

Backend — apps/api/src/routes/landlords.ts. New endpoint POST /me/onboard-tenants-csv/commit-pending inserted between /onboard-tenant-pending and GET /me/pending-tenants (line 817).

Per-row processing inside a single handler. Each row gets its own BEGIN/COMMIT/ROLLBACK — NOT all-or-nothing. If row 47 fails, rows 1-46 stay committed and visible in the pool. The result list mirrors input order so frontend can map errors back to specific CSV rows.

Identity re-validated server-side regardless of frontend classification — frontend hint is not a contract. Three conflict checks per row, lifted verbatim from /onboard-tenant-pending: cross-landlord active lease, same-landlord active lease, existing pending intent. The third check doubles as the in-CSV duplicate detector — row N+1 sees row N's intent and rejects with "This person is already in your pending pool."

Response shape: { success, data: { created, skipped, results: Array<{ rowIndex, email, status, intentId?, message? }> } }. Landlord sees per-row status: created (with intentId) or error (with message).

What this does NOT do: doesn't take lease fields from the row. Limbo intents have no lease data. CSV-supplied rent/dates are discarded — the parser will read them off the PDF later. Adding to deferred list: optional "user-provided priors" layer where CSV-typed lease fields get stashed in parser_output for the parser to compare against. Out of scope this session.

Frontend — TenantOnboardingPage.tsx. Three additions to BulkCsvMode:

splitDirtyRows() classifier next to splitFastPath(). IDENTITY_FIELDS = new Set(['first_name', 'last_name', 'email', 'phone']). A row is limbo-routeable iff it has at least one block-severity issue AND every block-severity issue is on a non-identity field. Mixed (identity + lease) blockers stay in punch list. Pure identity blockers stay in punch list. Pure lease blockers route to limbo. Defensive zero-blocker fallthrough keeps weird edge cases out of limbo.

validateMut.onSuccess rewired. Old flow: splitFastPath, fast-path commit, dirty rows go to punch list. New flow: splitFastPath, splitDirtyRows on the dirty bucket, fast-path commit (existing), limbo dispatch (new) — both run independently, neither blocks the other. Errored limbo rows pushed back into the punch list so landlord still sees them. Punch list settled once at the end of the chain.

Render — amber banner under the green fast-path banner. "X tenants routed to pending pool. Upload their lease PDFs to complete onboarding. Open pending pool" (the last bit is a clickable span using window.location.assign — anchor tag had a paste artifact, span works fine and the styling is identical). If any per-row errors from the backend, divider plus inline ul listing them as "Row N (email): message". Three handlers (handleFile, handleValidate, handleReset) clear limbo state alongside fastPathBanner so reset/replace flows don't leak stale banners.

LOCKED ARCHITECTURE DECISIONS — additions from this session

Single source of truth pattern extended to parser types. PARSER_STATUSES, PARSER_FLAG_CATEGORIES, PARSER_FLAG_SEVERITIES are const arrays in shared. Types derive from arrays. Metadata maps live next to the arrays. Adding a status, category, or severity = edit one place, all consumers pick it up. Drift remains a bug by definition.

Per-row transaction over batch transaction for limbo dispatch. When the cost of a single failure is surfacing one row to the user vs rolling back dozens of successes, per-row wins. Visibility was the locked decision in the architecture pivot; per-row is what makes that visibility honest.

Frontend classification is a hint, not a contract. Backend re-validates identity fields, conflict states, and unique constraints regardless of what the frontend claimed about the row. If frontend mis-classifies a row, the worst case is a clean per-row error in the response — never silent corruption.

The Build lease button is intentionally rendered and intentionally disabled until S29c-2-C lands the resolve endpoint. Better to show the user what's coming with a clear "next release" tooltip than to hide the entry point and surprise them later. UI surface is fully built out; the backend is the missing piece.

Single quoted heredocs and Python str_replace with explicit anchor uniqueness checks remained the editing pattern. New addition this session: must_replace() helper that applies each replacement immediately rather than batching. Sequential anchor checks must operate on post-replacement state when later edits depend on earlier ones. Got bitten once mid-session and recovered cleanly via the helper pattern.

When a Python heredoc has multiple sequential replacements that may depend on each other, write must_replace(s, old, new, label) and assign back to s on each call. Don't batch s.replace().replace().replace() at the end — that hides ordering bugs until the assert chain explodes.

Chat client auto-linking is a known and recurring rendering nuisance. Anything matching .word where word resembles a TLD (.app, .me, .map, .email, .total, .post, .data) gets wrapped as [thing.tld](http://thing.tld) when it round-trips through the chat client. The actual file is unaffected — TSC ignores it. Ignore in recon output. Verify against TSC, not against your terminal scrollback.

Standing rule, escalated this session: NEVER suggest, propose, or run smoke walks/tests at the start of a session, after a handoff, or as a "mandatory opener." Never list deferred smoke walks as a required step. Never frame smoke testing as something Claude should initiate. Smoke walks happen ONLY when Nic explicitly brings them up himself. Encoded in user memory after the 8th repetition.

FILES CHANGED

packages/shared/src/index.ts — appended ~95 lines of parser types after line 1583. New length ~1703.

apps/landlord/src/main.tsx — import line 17, nested route line 92.

apps/landlord/src/pages/TenantOnboardingPage.tsx — 636 → 981 lines. Three top-level additions: useNavigate import, useQuery import, Inbox icon, apiGet plus api imports. New state (pendingCount), new component (SingleTenantMode), new component (BulkCsvMode internals: limboBanner, limboErrors state, splitDirtyRows function, /commit-pending dispatch in onSuccess). New mode picker third card. Limbo banner render block under fastPathBanner.

apps/landlord/src/pages/PendingTenantsPage.tsx — 657 lines new.

apps/api/src/routes/landlords.ts — new endpoint POST /me/onboard-tenants-csv/commit-pending inserted at line 817 between /onboard-tenant-pending and GET /me/pending-tenants. ~155 lines.

No DB schema changes this session. pending_tenant_intents table from S29c-2-A is unchanged.

SUGGESTED COMMIT MESSAGE

S29c-2-B: tenant onboarding limbo frontend plus CSV limbo routing. Shared: ParserStatus, ParserFlag, ParserOutput, ParserExtractedField types plus const arrays plus metadata maps in packages/shared/src/index.ts (single source of truth). Frontend: PendingTenantsPage with status badges, stop-when-idle polling, inline PDF upload (multipart override), pdf.js viewer modal, delete confirm cascade, FlagsDetail with side-by-side intent vs parser output, Build lease button disabled pending S29c-2-C. SingleTenantMode replaces placeholder — name/email/phone form with optional inline PDF upload, three exit paths. Mode picker grows to 3 cards with pending count badge. CSV: backend POST /me/onboard-tenants-csv/commit-pending per-row endpoint with per-row transaction (NOT all-or-nothing) and identity re-validation server-side; frontend splitDirtyRows classifier routes lease-only-blocker rows to limbo, identity-blocker rows stay in punch list, mixed blockers stay in punch list. Amber limbo banner with per-row error list under green fast-path banner. Build lease endpoint and parser stay deferred to S29c-2-C+.

WHAT'S QUEUED FOR S29C-2-C

In suggested build order:

1. POST /me/pending-tenants/:intentId/resolve. Landlord-driven lease creation from intent plus parser output plus landlord overrides. Builds the lease, inserts lease_tenants link, sets email_verify_token, fires emailTenantOnboarded, marks intent parser_status='resolved' with resolved_lease_id and resolved_at. Promotes the PDF from uploads/lease-pdfs-pending/ to uploads/leases/. Wires the existing UI Build lease button (currently disabled).

2. Real PDF parser implementation. Replaces schedulePendingParserStub. Outputs to ParserOutput shape locked in S29c-2-B. Per the standing rule (no third-party AI APIs for core data), parser must run on GAM infrastructure when it lands. Strategy is open — in-house ML, regex-based, hybrid — pick at recon time.

3. Multi-tenant lease build flow. When two limbo intents share a unit-implied parsed lease (e.g. CSV had two rows for the same unit, both routed to limbo), the resolve flow should detect that on PDF upload and offer to bundle them on one lease vs build two. Currently each intent is independent. Spec at recon time.

S29c-2-D AND BEYOND

Schema drift bug. Pre-existing from S29c-1. Live DB has columns schema.sql doesn't (tenants.onboarding_source, tenants.platform_status, leases.lease_source, leases.imported_pdf_url, leases.needs_review, units.unit_type, plus more from S29c-1, plus pending_tenant_intents from S29c-2-A which IS in schema.sql). Dedicated session: diff live DB against schema.sql, back-fill every missed ALTER as ALTER TABLE ADD COLUMN IF NOT EXISTS, verify a fresh migrate produces a working DB. High priority because new-developer onboarding is broken until then. Standing pattern in the meantime: every schema change applied to BOTH the live DB AND schema.sql in the same paste.

E-sign /files/:filename auth gap. GET /api/esign/files/:filename serves any PDF to anyone with the filename. Pending-intent PDF endpoint (S29c-2-A) was built behind Bearer auth from the start. The e-sign hole still exists. Same dedicated session probably as the schema-drift fix or its own — both are security-flavored cleanup.

pdf.js loader extraction. Now duplicated 5 times across the monorepo (tenant LeasePage, tenant SignPage, landlord SignPage, landlord ESignPage, landlord PendingTenantsPage). Extract to a usePdfJs() hook or <PdfViewer> component in packages/shared, refactor 5 sites. Mechanical. Adding 6th site is fine until then; 5 is already past the point where copy-paste rot matters.

Optional CSV-typed lease priors. When a CSV row is routed to limbo today, the rent/dates the landlord typed are discarded. Future enhancement: stash CSV-supplied lease fields in parser_output as a "user-provided" priors layer for the parser to compare against. Helps the parser flag mismatches between what landlord typed and what the PDF says. Out of scope for S29c-2-C unless parser strategy benefits from it.

CARRIED-FORWARD DEFERRED LIST (active, not new this session)

Tenant-pool endpoint — trivially buildable on top of tenants.onboarding_source. Single query returning onboarded plus applied tenants scoped to landlord. Was slated for S29d alongside S29b item 7. Now genuinely unblockable since onboarding rails ship real tenant rows.

Platform-specific CSV import mappings (Buildium, AppFolio, DoorLoop, Yardi, RentManager, Propertyware, Rentec Direct, TenantCloud, plus 1-2 TBD by Nic). Pure additive: extends source param dispatch plus per-platform column-name translation table.

tenants.background_check_status / background_check_id columns missing but routes/background.ts writes to them. UPDATEs silently throw, swallowed by next(e). BG status lives correctly on background_checks table directly. Dedicated session: add columns plus backfill, OR rip the stale UPDATEs.

5 of 8 npm audit vulnerabilities (nodemailer pending email consolidation; uuid via node-cron plus svix plus resend pending major-version session for node-cron).

Tenant-pool picker (no free-text email) plus unit picker with consent rule plus backend enforcement on POST /esign/documents — now unblocked by onboarding rails. Backend enforcement: POST /esign/documents rejects occupied-unit sends without full active-tenant roster.

Extract void cascade switch into shared helper (currently duplicated between routes/esign.ts manual void and jobs/scheduler.ts auto-void).

Wrap POST /sign/:documentId in transaction.

POST /esign/documents should also reject executionFailed docs.

Notifications schema rebuild (its own dedicated session per Nic).

Witness in send modal.

Tenant draft persistence (autosave fieldValues to server) — loses progress on tab close.

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

Email-failure surface to landlord UI. Spans /commit (S29c-1) and will inherit through /onboard-tenant-pending plus /resolve when activation email lands at resolve time. Should appear in onboarding history / dashboard so landlord can resend or share URL directly.

Punch-list-resubmit limbo dispatch. Today, fixing identity blockers in the punch list and resubmitting goes through /commit, which still rejects rows with lease blockers. Adding limbo dispatch to punch-list submit means pure-lease-blocker rows after fix go to limbo automatically. Edge-case complexity for an edge-case scenario (landlord typed bad email AND missing rent on the same row). Common cases fully covered today.

TSC rot from S19: admin.ts AppError import (3 sites), announcements.ts pool import, auth.ts @gam/shared rootDir plus missing query, background.ts vision unknown access errors, fitness.ts AuthRequest vs AuthPayload, units.ts:395 .id on AuthPayload. Boots via tsx tolerance.

End of S29c-2-B handoff.
