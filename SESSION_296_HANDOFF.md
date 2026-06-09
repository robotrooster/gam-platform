# Session 296 — closed

## Theme

Built the verification lifecycle that closes the loop on S295's
review queue. Replaces the S295 "first 5 commits" heuristic with
an explicit per-(platform, import_type) verification flag set by
super admin. Once a slot is marked verified, the review banner
stops appearing on the landlord side and new uploads stop
generating queue noise. Regular admin (CS/sales) gets read-only
access to the queue list (no PII detail) while super admin keeps
full review + verify powers.

Product framing locked: verification is the truthful signal, not
count. The "first 5" framing made sense as a proxy when nothing
else existed; with explicit verification state we can drop
count-based copy entirely.

## Items shipped

### Schema: `platform_review_status`

Migration `20260516120000_platform_review_status.sql` creates the
verification gate table:

- **PK** `(platform_key, import_type)` — 27 possible slots
  (9 platforms × 3 import types: tenant / property / payment)
- `mapping_status` text — 'unverified' (default) or 'verified'
- `verified_at`, `verified_by` (FK users), `notes`
- `created_at`, `updated_at`
- CHECK constraints on `import_type` (3 values) and
  `mapping_status` (2 values)

Lazy-populated: no seed row at migration time. Missing row =
unverified (service helper handles the fallback).

### Service: `getPlatformReviewStatus` replaces `getPlatformPosition`

`apps/api/src/services/csvImportAttempts.ts`:

- Removed the count-based `getPlatformPosition()` function +
  `FIRST_N = 5` constant.
- Added `getPlatformReviewStatus(platformKey, importType)` —
  returns `{mappingStatus, escalateToSuperAdmin}`. Queries the
  new table; falls back to 'unverified' on no row OR on error.

Three commit handlers updated to call the new helper. Response
fields renamed: `firstFive` / `position` → `escalateToSuperAdmin`
/ `mappingStatus`.

### Banner copy: neutral, no count

All three landlord onboarding pages updated:

- `PaymentHistoryOnboardingPage.tsx`
- `PropertyOnboardingPage.tsx`
- `TenantOnboardingPage.tsx`

New copy:

> **We're reviewing your [Platform] migration for accuracy.**
>
> Our team checks the column mapping on every new [Platform]
> import to make sure your data landed cleanly. If anything
> looks off we'll reach out. No action needed from you.

State renamed `firstFiveBanner` → `reviewBanner`. CommitResponse
type fields renamed.

### Admin API: 2 new endpoints + 1 access broadened

**Broadened:**
- `GET /api/admin/csv-import-attempts` — dropped `requireSuperAdmin`.
  Now admin OR super_admin can list (no tenant PII at list level).
  Detail + mark-reviewed still super_admin-gated.

**New endpoints (both call `logAdminAction`):**
- `GET /api/admin/platform-review-statuses` (admin OK) — returns
  every slot that has either a verification row OR a commit,
  joined with commit-count stats. Slots with no
  platform_review_status row default to 'unverified'.
- `POST /api/admin/platform-review-statuses/:platform/:type/verify`
  (super_admin) — upsert to verified, stamps verifier + timestamp.
  Accepts optional `notes` in body.
- `POST /api/admin/platform-review-statuses/:platform/:type/unverify`
  (super_admin) — reverts a verified slot back to unverified.
  Used when a mapping change ships that materially alters
  column handling.

### Admin UI: verification grid + role-gated actions

`apps/admin/src/main.tsx`:

- **Page access opened to admin** — dropped `<SuperAdminGuard>`
  wrapper on the `/csv-imports` route; dropped `isSuperAdmin&&`
  gate on the nav link.
- **New "Platform verification status" grid** replaces the S295
  count-based "Platforms by commit count" tile. One card per
  (platform, import_type) slot showing:
  - Platform name + import type
  - Mapping status badge (verified = green; unverified = neutral)
  - Customer count + commit count
  - Verifier + verification date (when verified)
  - **Super admin only:** "Mark verified" / "Unverify" CTA
- **List table actions** — super_admin sees View + Mark reviewed
  buttons; admin sees a "super_admin only" pill where the
  buttons would be.
- **Sub-header badge** now shows the current user's role
  ('admin' or 'super_admin') instead of hard-coded
  'super_admin only'.

### Verification mutations cross-invalidate

Verify + unverify mutations invalidate both
`['platform-review-statuses']` AND `['csv-imports']` query keys —
so the list table re-fetches and shows the updated status
column when the slot flips.

## Files touched (S296)

```
apps/api/src/db/migrations/
  20260516120000_platform_review_status.sql   (new)

apps/api/src/db/
  schema.sql                                  (regenerated)

apps/api/src/services/
  csvImportAttempts.ts                        (getPlatformPosition
                                               replaced with
                                               getPlatformReviewStatus)

apps/api/src/routes/
  landlords.ts                                (3 commit handlers swap
                                               counter call for
                                               verification call;
                                               response field renames)
  admin.ts                                    (~+115 lines — 3 new
                                               endpoints, 1 access
                                               broadening)

apps/landlord/src/pages/
  PaymentHistoryOnboardingPage.tsx            (banner state +
                                               response type rename;
                                               new copy)
  PropertyOnboardingPage.tsx                  (same)
  TenantOnboardingPage.tsx                    (same)

apps/admin/src/main.tsx                       (CsvImports rebuilt;
                                               new verification
                                               grid; role gates;
                                               new mutations;
                                               page access opened to
                                               admin role)

SESSION_296_HANDOFF.md                        (this file)
```

## Decisions made during build

| Question | Decision |
|---|---|
| Verification table seeded at migration time, or lazy-populated? | **Lazy.** Missing row = unverified (service falls back). Avoids 27-row seed that would mostly be useless rows. Verified status only created when super admin actively marks. |
| "First 5" framing in landlord copy — keep, drop, or hybrid? | **Drop.** Verification is the truthful signal, not count. Nic confirmed operationally we'll verify by upload #5, so the count was always a proxy. Neutral copy aligns with the verification model. |
| Page-level access — super_admin only, admin OK, or split? | **Page opens to admin** (list + verification grid both visible). **Detail modal + Mark reviewed + Verify/Unverify gated to super_admin.** Per Nic: super admin = dev/CEO; admin = CS/sales. Sample rows carry tenant PII so detail stays tight; queue triage is fine for CS. |
| Where does the verification grid live — separate page or merged into CsvImports? | **Merged into CsvImports.** It's the same conceptual surface (review queue + per-platform state). Two pages would split context. The S295 "commit count" tile becomes the verification grid (same data, different framing). |
| Allow unverify (revert verified → unverified)? | **Yes — super_admin only.** Needed when we ship a mapping change that materially alters column handling and want to force re-review of the next imports. Confirm() prompt on the client to prevent fat-fingers. |
| Default 'mapping_status' value: 'unverified' as a row OR no row at all? | **No row at all.** Service helper falls back to 'unverified' for missing rows. Cleaner — only stores rows that represent positive action by super admin. The table effectively tracks "what's verified" not "what exists." |
| Admin nav emoji on /csv-imports — strip per CLAUDE.md? | **Keep.** Existing 12+ admin nav links all carry emojis (🏢 🏦 ⚡ 🧾 etc.). Stripping the one I added creates visual inconsistency for no clear benefit. Flagging in case Nic wants a full strip pass — that's a UI-batch concern, not S296 scope. |
| Backend: hardcoded N=5 threshold survive anywhere? | **No.** The S295 stats endpoint (`/csv-import-attempts/_stats/platforms`) still returns commit counts but the "≤5" framing is gone everywhere — both backend and frontend. |

## Verification

- `cd apps/api && npx tsc -b` → clean.
- `cd apps/landlord && npx tsc --noEmit` → clean.
- `cd apps/admin && npx tsc --noEmit` → clean.
- `cd apps/api && npm test` → **233 / 233 passing**. No regressions.
- Migration applied via `npm run db:migrate`; schema.sql regenerated.

## Items deferred (S296-specific)

- **Most-recent-validate cross-link from commit detail rows** —
  commit rows carry empty column_headers / sample_rows. Detail
  modal copy points users to the validate row but doesn't link.
  Add in a polish pass or alongside notification work.
- **Email notification to super_admin on new unverified upload** —
  queue is still pull-based today. Worth adding before real
  customer migrations start so super admin doesn't have to poll.
- **Stats tile on admin Overview page** — pending-attempts count
  as a quick KPI on the Overview landing. Discoverability nice-to-have.
- **Per-platform notes / review history** — `platform_review_status.
  notes` is captured but not rendered anywhere yet. Add a notes
  textarea to the verification card if needed.
- **`csv_import_attempts._stats/platforms` deprecation** — still
  used internally by the count-stats query; could be removed
  cleanly once the verification grid fully replaces the prior
  tile in operator workflows.

## Items deferred (cross-session docket, unchanged)

- **S297: Generic claim aggregation + promotion.** Required
  "What platform is this?" text input on generic uploads
  (writes `claimed_platform_name` already-present column);
  aggregation view; promotion → code change.
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

## What S297 should target

**Generic claim aggregation + promotion** — the last piece of the
review-system spec from the morning's discussion.

1. **Generic onboarding flow** gains a required "What platform
   is this from?" text input. Writes to `csv_import_attempts.
   claimed_platform_name` (column already exists from S295) on
   validate + commit.
2. **Admin aggregation view** — new section on the CsvImports
   page (or new page) showing platforms-claimed-from-generic
   grouped by normalized name, with claim counts. Promotion
   candidates surface when ≥ N claims share the same normalized
   name.
3. **Promotion action** — clicks "Promote" which:
   - Logs the intent to `admin_action_log` (audit trail)
   - Generates a stub mapping file scaffold (or pings developer
     channel) — actual mapping requires a code-change session
   - Probably stays advisory in S297; the actual code change
     happens manually
4. **Generic uploads matching a real platform name** — should
   we still capture as 'generic' or auto-route? Probably keep
   as 'generic' with the claim metadata so we don't pretend to
   have full mapping coverage when we don't.

---

End of S296 handoff. Closed clean.
