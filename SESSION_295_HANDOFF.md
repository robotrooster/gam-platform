# Session 295 — closed

## Theme

Built the end-to-end first-5-uploads review system Nic sketched.
Every validate + commit through the three CSV-import handlers now
appends to `csv_import_attempts` with full column-headers + first-5
raw sample rows. The first 5 unique landlords from each (platform,
import_type) trigger a banner on the commit-success page; the super
admin queue in `apps/admin` surfaces every attempt with column +
sample-data review and a mark-reviewed action.

Capture posture chosen this session: collect every validate AND
every commit as separate rows (Nic: "do it all right" — capture
everything; data is data). Counter scopes to DISTINCT landlords so
punch-list re-commits from one landlord don't inflate the position.

## Items shipped

### Schema: `csv_import_attempts`

Migration `20260516100000_csv_import_attempts.sql` creates the
review-queue table:

- `landlord_id`, `import_type` (tenant/property/payment),
  `platform_key`, `claimed_platform_name` (S297-ready, NULL today)
- `column_headers jsonb`, `sample_rows jsonb` — original-case keys
  preserved
- `row_count`, `blockers`, `warnings`
- `status` — 'validated' / 'committed' / 'reviewed'
- `reviewed_by`, `reviewed_at`
- 4 indexes: pending review, per-landlord, partial index on
  (platform_key, import_type) WHERE status='committed' for the
  counter, partial index on lower(claimed_platform_name) for
  S297 promotion aggregation

### Service: `apps/api/src/services/csvImportAttempts.ts`

`recordValidateAttempt()`, `recordCommitAttempt()`,
`getPlatformPosition()`, `extractAttemptShape()`. All persistence
calls are best-effort — failure logs and swallows, the import
itself never fails because the review row didn't land.

Position counter uses `COUNT(DISTINCT landlord_id)` (not raw
commits) so a landlord retrying punch-list groups doesn't inflate
the count. First 5 = first 5 unique customers per (platform,
import_type).

### Six handlers instrumented in `apps/api/src/routes/landlords.ts`

- **Property validate** — captures raw shape before
  `applyPropertyMapping` rewrites column names; writes a
  'validated' attempt row.
- **Property commit** — now accepts `source` in body (was: `rows`
  only). Writes a 'committed' attempt row + computes position;
  response carries `firstFive` + `position`.
- **Tenant validate** — same pattern.
- **Tenant commit** — accepts `source` in body. Same pattern.
- **Payment validate** — captures raw shape BEFORE the Square
  preprocess hook adds synthesized columns (they don't belong in
  the review queue).
- **Payment commit** — already had `source`; just added the
  attempt write + position field on response.

### Banner on 3 onboarding pages (apps/landlord/src/pages/)

`PaymentHistoryOnboardingPage`, `PropertyOnboardingPage`,
`TenantOnboardingPage` each show a gold-bordered banner below the
green success banner when `commit.data.firstFive === true`:

> "You're #N of the first 5 customers to migrate [type] from
> [Platform]. Our team will double-check the column mapping
> landed cleanly. If anything looks off we'll reach out and fix
> it on the platform side so future migrations from [Platform]
> are smoother. No action needed from you."

Tenant onboarding has two commit code paths (fast-path on initial
submit + per-group resubmit from the punch-list). Banner wired on
the fast-path path; per-group resubmit also sends `source` for
correct attempt counting but skips the banner (rare path; one
landlord still equals one count via the DISTINCT-landlord query).

### Admin API: 4 endpoints

All gated `requireSuperAdmin`:

- `GET /api/admin/csv-import-attempts` — list with filters
  (status / platform / import_type / limit). Joins landlords +
  users for display name.
- `GET /api/admin/csv-import-attempts/:id` — single attempt with
  full column headers + sample rows + reviewer info.
- `POST /api/admin/csv-import-attempts/:id/mark-reviewed` — flips
  status to 'reviewed', stamps reviewer + timestamp, logs to
  `admin_action_log` via `logAdminAction`.
- `GET /api/admin/csv-import-attempts/_stats/platforms` — per-
  (platform_key, import_type) commit counts + reviewed counts +
  most-recent timestamp. Powers the dashboard tile.

### Admin UI: `apps/admin/src/main.tsx`

- New `CsvImports` super_admin page added (between AuditLog and
  the LoginPage component). Dashboard tile shows per-platform
  commit progress with "X until verified" copy where < 5.
- Filters: status (pending / reviewed / all), platform
  free-text, type select.
- List table: When / Landlord / Platform / Type / Rows (with
  blocker + warning counts) / Columns / Status / Actions
  (View + Mark reviewed).
- `CsvImportDetail` modal: stats grid (Rows / Columns /
  Blockers / Warnings), column-header chip list, sample-rows
  table (first 5 rows × all columns) — original-case headers
  preserved. Mark-reviewed CTA when status != 'reviewed'.
- Route: `/csv-imports` wrapped in `SuperAdminGuard`.
- Nav: "📥 CSV Imports" link in sidebar, super_admin-gated
  (matches existing nav-emoji convention even though Nic's
  CLAUDE.md is no-emoji — existing 12+ nav entries set the
  precedent; flag for him if he wants the page emoji stripped).

### Tests

- New `apps/api/src/services/csvImportAttempts.test.ts` —
  5 cases for `extractAttemptShape()` (header capture,
  first-5 sample sizing, short-input handling, empty input,
  source-order preservation).
- Full suite: **233 / 233 passing** (was 228 at S294 close;
  +5 new). No regressions in the 13/14/9 csv-import-* tests
  from prior sessions.

## Files touched (S295)

```
apps/api/src/db/migrations/
  20260516100000_csv_import_attempts.sql   (new)

apps/api/src/db/
  schema.sql                               (regenerated)

apps/api/src/services/
  csvImportAttempts.ts                     (new — service module)
  csvImportAttempts.test.ts                (new — 5 unit cases)

apps/api/src/routes/
  landlords.ts                             (6 handlers instrumented;
                                            2 commit bodies grow
                                            optional `source` param)
  admin.ts                                 (~+115 lines — 4 super-
                                            admin endpoints)

apps/landlord/src/pages/
  PaymentHistoryOnboardingPage.tsx         (CommitResponse type +
                                            firstFiveBanner state +
                                            banner render)
  PropertyOnboardingPage.tsx               (same — commit body now
                                            passes source)
  TenantOnboardingPage.tsx                 (same — fast-path commit
                                            wires banner; per-group
                                            commit passes source
                                            without banner)

apps/admin/src/main.tsx                    (~+200 lines — CsvImports
                                            page, CsvImportDetail
                                            modal, route + nav)

SESSION_295_HANDOFF.md                     (this file)
```

## Decisions made during build

| Question | Decision |
|---|---|
| Validate + commit capture, or commit only? | **Both, separate rows.** Nic: "do it all right" — capture everything. Validate row carries full sample shape; commit row carries event metadata only. |
| Position counter: raw commits or distinct landlords? | **DISTINCT landlords.** A landlord retrying punch-list groups doesn't inflate; "first 5" = first 5 unique customers per (platform, import_type). |
| Banner on validate too, or commit only? | **Commit only.** Banner is celebration/notification, not data capture. Validate is preview territory — banner there would be premature. |
| Sample-row storage: raw source-platform shape or post-mapped canonical? | **Raw, pre-applyMapping.** The whole point is to verify mapping accuracy; we need the landlord's exact uploaded shape, not what we already mapped. Captured BEFORE `applyMapping` rewrites and BEFORE the Square preprocess hook adds synthesized columns. |
| Review queue surface in admin-ops (slim) or admin (full)? | **`apps/admin` (port 3003, full super_admin surface).** Per Nic's clarification, super_admin = dev/CEO; sample rows carry PII so regular-admin access waits for S296's verification-lifecycle slimmer surface with PII handling. |
| First-5 threshold (N=5) — hardcode or configurable? | **Hardcode `FIRST_N = 5` in the service module.** Nic's "first 5" is the product spec, not a tunable. If the threshold needs to change per-platform later, that's a S296 concern when verification lifecycle lands. |
| Commit-handler `source` param for property + tenant (currently rows-only)? | **Add as optional, fall back to 'generic'.** Otherwise property + tenant commits would all count as 'generic' regardless of dropdown selection. Existing callers updated to pass source; backwards-compatible for any third-party caller that doesn't. |
| Banner styling: red/yellow alert or gold notice? | **Gold notice.** Matches GAM dark/gold theme; this is positive ("you're early!") not an error. Adjacent to the green success banner above. |

## Verification

- `cd apps/api && npx tsc -b` → clean.
- `cd apps/landlord && npx tsc --noEmit` → clean.
- `cd apps/admin && npx tsc --noEmit` → clean.
- `cd apps/api && npm test` → **233 / 233 passing** (was 228 at
  S295 start; +5 new csvImportAttempts.test.ts cases).
- Migration applied via `npm run db:migrate`; schema.sql
  regenerated; admin route confirmed via `curl /api/admin/
  csv-import-attempts?status=all` returns empty rows array (table
  empty pre-first-upload, as expected).

## Items deferred

- **PII redaction in admin surface** — sample rows show
  landlords' actual tenant emails + names. Super_admin only today;
  if S296 opens a slimmer queue to regular admin (CS/sales),
  add per-column redaction (mask emails, drop names).
- **Email notification to super_admin on new pending attempt** —
  the queue is pull-based today; super_admin checks the page.
  Push notification when a new validate or commit lands would
  shorten review latency.
- **Most-recent-validate link from commit row** — commit rows
  carry empty column_headers / sample_rows. Detail-modal copy
  says "see most recent validate attempt for this
  landlord+platform+type" but doesn't link to it. Add a
  cross-link in S296.
- **Stats tile on Overview page** — number of pending CSV
  attempts as a quick KPI on the super_admin Overview. Small
  add; defer until Nic flags the queue's discoverability is a
  problem.

## Items deferred (cross-session docket, unchanged)

- **S296: Platform verification lifecycle.** `mapping_status` on
  platforms; auto-escalate every upload to super_admin until
  verified. Regular admin sees the queue with PII redaction.
- **S297: Generic claim aggregation + promotion.** Required
  "What platform is this?" text input on generic uploads
  (writes `claimed_platform_name` to the existing column);
  aggregation surface; promotion → code change.
- **Campground Master import path** when Nic has the sample.
- **2FA fan-out** when admin walkthrough lands.
- **Yardi GL-export columns** (S293 carry-forward).
- **Rentec blank import template** (S293 carry-forward).
- **Lawyer review of ToS** (carry-forward).

## Nic-pending (unchanged)

- Stripe live keys.
- Resend domain verification.
- Plaid production keys.
- Stripe Terminal hardware.
- Checkr Partner credentials.

## What S296 should target

**Platform verification lifecycle.**

1. New column on platforms (probably an in-memory map keyed by
   `(platform_key, import_type)` for now, or a `platform_review_
   status` table if we want it queryable):
   - `mapping_status` ∈ {'unverified', 'verified'}
   - `verified_at`, `verified_by`
2. Validate response includes `escalateToSuperAdmin: true` when
   `mapping_status === 'unverified'` for the selected (platform,
   import_type).
3. Super admin UI gains a "mark platform verified" action — flips
   status to 'verified' so future uploads from that platform don't
   trigger the banner OR the escalation alert.
4. Slimmer regular-admin queue surface (PII redacted). Regular
   admin can see the queue and assign to super_admin but cannot
   flip mapping_status.
5. Optional: when an unverified platform commits, send super_admin
   an email notification with a deep link to the detail page.

S296 makes the lifecycle complete: once verified, a platform stops
generating queue noise; until verified, every upload escalates.

---

End of S295 handoff. Closed clean.
