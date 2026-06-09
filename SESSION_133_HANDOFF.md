# Session 133 Handoff

**Theme:** Compliance archive cron. Resolves the long-deferred
"retention windows" item by codifying a different decision:
GAM keeps all compliance/audit data forever (no legal cap), but
moves rows older than 24 months out of the hot tables into
`<table>_archive` siblings to keep day-to-day reads fast.

## Architecture decisions

**Archive, don't delete.** Retention policy = "keep forever
where legally allowed." The cron never deletes — it only
*relocates* aged rows. Hot table stays small; archive holds the
full history. Both are queryable, but admin endpoints default
to hot-only.

**24-month cutoff.** Not a legal window — just a hot/cold
boundary. Picked as a comfortable number that essentially never
catches operationally-active data. Pre-launch, no row will hit
it for at least 24 months from go-live; the cron runs as a
no-op until then.

**One row, one place.** `WITH moved AS (DELETE … RETURNING …)
INSERT INTO archive SELECT FROM moved` runs in a single
transaction. A row never exists in zero places, never in two.
Atomic guarantees come from PG.

**Archive tables drop FKs.** `LIKE … INCLUDING DEFAULTS
INCLUDING CONSTRAINTS` copies columns + defaults + CHECK
constraints, but not foreign keys. Archives are append-only
history; if a referenced user/payment/etc. gets deleted or
archived later, the archive row should not break. Indexes also
not copied — archive is rarely scanned; add specific indexes
if a query pattern emerges.

**`admin_notifications` archives only acknowledged rows.**
An unacked notification is by definition still actionable;
archiving it would hide an active alert. Filter:
`archived_at IS NOT NULL AND created_at < cutoff`.

**Generic helper, not table-by-table code.** The archival
function reads `information_schema.columns` at runtime to build
the column list — one helper handles all six tables. The only
per-table customization is the optional `extraWhere` filter
(used by admin_notifications). Adding a new compliance table
to the cron is a one-line registration.

**Monthly cadence, 1st @ 2am Phoenix.** Same window as the fee
accruals (1am, 1:30am). Light contention, predictable
boundary.

## Shipped

### Migration `20260505110000_compliance_archive_tables.sql`

Six new archive sibling tables:
- `admin_action_log_archive`
- `audit_log_archive`
- `bulletin_reveal_log_archive`
- `ach_monitoring_log_archive`
- `admin_notifications_archive`
- `email_send_log_archive`

Each: `LIKE <hot> INCLUDING DEFAULTS INCLUDING CONSTRAINTS` +
`archived_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`.

Applied via `npm run db:migrate` → 1 applied; schema.sql
regenerated (now 8471 lines).

### apps/api/src/jobs/complianceArchive.ts (new)

One export: `processComplianceArchive()`. Iterates the six
target tables, runs the atomic move per table inside its own
transaction, returns `{ stats: [...], errors: [...] }`. Each
table's failure is isolated (one bad table doesn't kill the
others).

### apps/api/src/jobs/scheduler.ts

Added monthly cron at `0 2 1 * *` Phoenix. Same failure-isolation
pattern as the surrounding accrual jobs (try/catch, log result,
continue).

## Files touched

- `apps/api/src/db/migrations/20260505110000_compliance_archive_tables.sql`
  (new)
- `apps/api/src/db/schema.sql` (regenerated)
- `apps/api/src/jobs/complianceArchive.ts` (new)
- `apps/api/src/jobs/scheduler.ts` (monthly cron added)
- `SESSION_133_HANDOFF.md` (this file)

No shared package changes, no route changes.

## Validation

- `npm run db:migrate` → 1 applied
- `npx tsc --noEmit -p apps/api/tsconfig.json` → exit 0
- Live smoke against dev DB:
  - Inserted a `smoke_test_old` row in admin_action_log dated
    25 months ago
  - Ran `processComplianceArchive()` directly via ts-node
  - Verified: `archived: 1` for admin_action_log, `0` for the
    other five tables (no aged data exists yet)
  - Confirmed atomic move: hot count = 0, archive count = 1
  - Cleanup: deleted smoke row from archive

## What this session did NOT do

- **No admin endpoint to query archives.** Hot reads stay
  unchanged; archive query path waits until a UI need surfaces.
  Today an admin who wants archived data can SQL it directly.
- **No backfill.** Pre-launch, nothing is older than 24 months.
  The cron starts running 1st of next month; first non-zero
  archival activity ~24 months post-launch.
- **No retention policy on archive itself.** Archive grows
  unbounded by design. If volume becomes a real cost, future
  pass can add cold-storage offload (S3/JSONL) — but that's a
  decision for post-launch when actual data volume informs it.
- **No alerting on archive failure.** The cron logs to console
  on fatal error like every other cron in the file. Could
  promote to `createAdminNotification` (S132) but the surface
  area is small enough that the existing console-error pattern
  is fine pre-launch.

## Pre-launch backend status

Add to closed list:
- ✅ Compliance archive cron (24-month hot/cold boundary, 6
  tables)
- ✅ Retention policy decision: keep forever (codified inline
  in the migration header)

Open items:
- lease_fees due_timing wire-up (needs product call from Nic)
- OTP enablement (gated on FlexPay tier UX)
- Admin notifications portal UI (waits on frontend pass)
- Frontend pass for everything backend-ready
- Stripe sandbox testing (waiting on test API key)

## What next session should target

The pre-launch backend track is essentially closed. What's
left is either blocked on Nic input (due_timing rules) or on
external dependencies (Stripe key, FlexPay UX) or is a frontend
build.

Recommended next move: **start a fresh chat for the frontend
pass.** Backend is at the most feature-complete it's been;
frontend recon needs a clean context window to do justice to
the portal codebase.

If Nic wants to keep grinding backend, a `console.error` sweep
of the remaining ~80 sites against the S132 admin notification
service is the natural follow-up — but most of those are
routine email-failure or low-value paths. Diminishing returns.
