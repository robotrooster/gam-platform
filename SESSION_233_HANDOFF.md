# Session 233 — closed

## Theme

Bench session — Nic asked to start going through the open queue. Six
DEFERRED items closed across CSV imports, tenant pool flow, schema
harness, and one e-sign UI cleanup. One real drift bug discovered and
fixed (the SELECT scanner extension paid for itself on first run).

## Items shipped

### 1. Platform-specific CSV import mappings — 7 platforms

Continuing the S231 framework (Buildium shipped), enabled the
remaining 7 platforms: AppFolio, DoorLoop, Yardi, RentManager,
Propertyware, Rentec Direct, TenantCloud. Each entry in
`apps/api/src/lib/csvImportMappings.ts` carries:
- columnMapping with documented + common-variant aliases per
  canonical GAM header
- ignoredColumns listing known-extra columns that get dropped
- notes string surfaced in the frontend's per-platform helper text

Caveats documented in the registry:
- AppFolio + Rentec Direct ship a combined "Tenant Name" column on
  some report variants — landlord splits to First/Last in their
  spreadsheet pre-upload (auto-name-splitting is its own can of
  worms; deferred).
- Yardi has multiple report variants (Voyager / Breeze / Resident
  Roster / Rent Roll); aliases cover the most common columns across
  them.

Frontend `apps/landlord/src/pages/TenantOnboardingPage.tsx`:
flipped all 7 entries to `enabled: true` and added per-platform
export-instruction copy in the step-2 helper text. Template
download URL passes the selected `source` so each platform gets
its own column-reference CSV.

DEFERRED: tombstoned. All 8 platforms (generic + 7 + Buildium)
shipped end-to-end.

### 2. Tenant-pool picker + unit picker

Replaced `apps/landlord/src/pages/ApplicantPoolPage.tsx` (was a
broken 39-line placeholder querying a nonexistent `/applicants`
endpoint) with the real pool-browse flow.

Backend additions:
- `GET /api/background/pool/matches` (new) — landlord's outgoing
  match requests with redacted pool entry preview + unit info +
  status; tenant identity (name/email/phone) returned only on
  rows where `mr.status='report_purchased'` (the $1 unlock fired).

Frontend:
- Filter bar (income range, state, risk level)
- Redacted-preview pool table (city/state, employment, income,
  risk, contacted-flag)
- Per-row "Reach Out" button → modal with vacant-unit picker +
  optional 500-char message → POST /background/pool/:poolId/reach-out
- "Your reach-outs" section below — the new /pool/matches feed
  with status badges (Awaiting tenant / Interested / Not interested
  / Report unlocked / Expired) and tenant-reply column

The $1 unlock-and-purchase-report flow is intentionally NOT in
this session — separate scope, requires Stripe Elements integration
on the landlord side, deferred to its own session. Frontend shows
"Interested — unlock to view" as a status pending that build.

### 3. Schema diff harness — SELECT FROM/JOIN scanner

`apps/api/scripts/diff-schema.ts` was INSERT/UPDATE-only pre-S233.
Added a SELECT scanner that catches table drift in read paths:

- Two-pass: extract backticked template literals first, then scan
  each for FROM/JOIN. The literal-only constraint eliminates the
  flood of false positives from English prose ("data FROM the
  user") matching the regex.
- Per-literal CTE alias detection (`<word> AS (` pattern) — CTEs
  introduce temporary tables that the existence check would
  otherwise flag. Conservative: any name appearing in `<name> AS (`
  gets allowlisted, also covers `(subquery) AS alias` patterns.
- Function-call detection: `FROM funcname(...)` is a set-returning
  function, not a table. Skip.
- Expression-paren detection: `EXTRACT(HOUR FROM created_at)` and
  similar use FROM as a syntactic delimiter inside the function
  arglist. Detect by walking back from the FROM position, finding
  the most recent unmatched open paren, and checking whether the
  preceding identifier is one of EXTRACT / SUBSTRING / TRIM /
  OVERLAY / POSITION / CAST.

Plus a SQL_KEYWORDS_AFTER_FROM blocklist (where, on, and, or,
group, order, etc.) so a partially-matched FROM clause doesn't
treat keywords as table names.

First run found 122 candidate "missing tables" — all turned out
to be CTEs, function calls, or expression-paren FROMs after the
guards landed. After full guards: **1 real drift catch**.

### 4. Schema diff harness — orphan-ack detection

When an ack in `diff-schema.acks` doesn't match any drift item
during a run, it's likely stale (the code it covered was
refactored). Added per-ack "fired" tracking; orphans get listed
at the end of the report under "Orphan acks (declared in file
but didn't suppress anything this run)" with cleanup hint.

The S59 carryforward "distinguish acks-file-listed vs.
acks-applied" is now delivered via:
- "Acks applied this run: X tables, Y columns, Z anti-patterns
  (of N ack lines in file)" — explicit count of file-listed vs.
  actually-suppressing
- Orphan list naming the unused acks

First run found exactly 1 orphan: `A:src/routes/esign.ts:430`
from S59. Verified the anti-pattern at that line is gone (line
430 is now blank between two real statements; the original
INSERT-without-columns refactor must have moved/deleted it).
Removed the ack.

### 5. Real drift fix — platform_announcements migration

The new SELECT scanner caught `routes/announcements.ts:12`
SELECTing from a `platform_announcements` table that doesn't
exist in the schema. The route is wired into the API at
`/api/announcements` and consumed by `AnnouncementBar` in
landlord layout — currently throws on every request, which
the layout swallows silently (falls back to static branding).

New migration `20260510120000_platform_announcements.sql`:
- Columns matching the SELECT (id, title, body, priority,
  created_at) plus `active` + `expires_at` for the WHERE clause
- CHECK constraint on priority ('info'|'warning'|'critical')
- Partial index on `(priority DESC, created_at DESC) WHERE
  active=true` — same shape the route's ORDER BY uses

Migration applied; harness re-run → SELECT side clean (0
missing tables on read path).

Admin CRUD surface for actually creating announcements is its
own future session — table exists empty, route returns empty
array, layout falls back to branding cleanly.

### 6. Movie-font signature → professional fonts

`SIG_FONTS` list in both `apps/tenant/src/pages/SignPage.tsx`
and `apps/landlord/src/pages/SignPage.tsx` had Terminator /
Matrix / Blade Runner / Mad Max as signature font options
(loaded from local .ttf files). Replaced with 5 professional
options using system-fallback chains: Elegant (Georgia
italic), Script (Snell Roundhand → Edwardian Script ITC →
Apple Chancery → cursive), Cursive (Brush Script MT → Lucida
Handwriting → cursive), Classic (Palatino), Modern (Garamond).

Each entry is a CSS font shorthand with multi-named-font
fallback chains so every OS renders something signature-shaped
even if the specific font isn't installed. No new files, no
Google Fonts dependency.

Stripped the @font-face injection block + the per-font-family
canvas-rendering branch + the FONT_LINK googleapis-link hook.
The `/fonts/*.ttf` files in `apps/tenant/public/fonts/` are
now orphaned — left in place; cleanup is a "git rm" question
for Nic.

The 4 `Layout.tsx` files (landlord / pos / tenant) that inject
the same movie-font @font-face blocks for their **whole-app theme
font selector** are intentionally unchanged — that's a separate
"app-wide font flair" feature, not the signature picker.

## Files touched (S233)

```
apps/api/src/lib/csvImportMappings.ts          (+ 7 platforms,
                                                ~ 200 lines)
apps/api/src/routes/background.ts               (+ /pool/matches
                                                  endpoint, ~30L)
apps/api/scripts/diff-schema.ts                 (+ SELECT scanner,
                                                + orphan-ack tracking,
                                                ~ 130 lines)
apps/api/scripts/diff-schema.acks               (- 1 orphan ack)
apps/api/src/db/migrations/
  20260510120000_platform_announcements.sql    (NEW)
apps/api/src/db/schema.sql                      (auto-regen)

apps/landlord/src/pages/ApplicantPoolPage.tsx   (full rewrite — 39L → ~330L)
apps/landlord/src/pages/TenantOnboardingPage.tsx (~ 7 enabled flips,
                                                  + per-platform helper copy)
apps/landlord/src/pages/SignPage.tsx            (~ SIG_FONTS, - movie
                                                  font @font-face + canvas
                                                  rendering branches)

apps/tenant/src/pages/SignPage.tsx              (~ same as landlord)

DEFERRED.md                                     (4 items tombstoned)
SESSION_233_HANDOFF.md                          (new)
```

## Verification

- `cd apps/api && npx tsc --noEmit` → clean
- `cd apps/landlord && npx tsc --noEmit` → clean
- `cd apps/tenant && npx tsc --noEmit` → clean
- `cd apps/api && npm run schema:diff` → SELECT side 0 drift, 1
  remaining orphan ack auto-removed, INSERT/UPDATE side has only
  the expected pre-launch Flex Suite phantoms
- AppFolio + Buildium mapping smoke (CSV → records): both translate
  correctly, ignored columns dropped

## Decisions made (S233)

| Question | Decision |
|---|---|
| Ship 7 platforms in one go vs. 1 per session? | Batched. The framework is settled (S231 Buildium proved the shape); adding 6 more was 7 mapping blocks of ~25 lines each, no different-shaped logic. Real-export verification comes when customers actually migrate from each platform; that feedback loop is the same regardless of cadence. |
| Tenant pool — replace ApplicantPoolPage or add a parallel page? | Replace. The current page was broken (querying nonexistent `/applicants`) and the nav entry already pointed at it. Building a parallel page would have left two pool-browse surfaces with one perma-broken. |
| Include the $1 unlock flow in this session? | No. Unlock requires Stripe Elements integration on the landlord side (the `/pool/match/:matchId/payment-intent` + `/purchase-report` flow already exists backend-side). Out of scope for this session; landed status badges so the gap is visible. |
| Hard-error vs. silent skip on AppFolio combined-name column? | Document caveat + let validator fail per row. The validator already reports per-row missing-required-field issues; "split your name column" lands clearly when the row shows blank first_name + last_name. Auto-splitting "Last, First" / "First Last" strings has too many edge cases (suffixes, hyphenated names, single-name people) to ship without spec. |
| SELECT scanner — full per-column verify vs. table-only? | Table-only. Per-column SELECT verification needs a real SQL parser (alias resolution, function calls, subqueries, CTEs). Table-name drift is the highest-value catch and needs only regex + paren tracking; column refs in SELECT clauses don't move the needle enough to justify the parser. |
| Should the harness fail-fast on orphan acks? | No, just warn. Orphans are stale-cleanup hints, not bugs in code. Failing the build on them would punish anyone editing acks; warning is enough to surface them in the regular run output. |
| Touch the Layout font selectors when ripping movie fonts? | No. That's an app-wide theme-font feature (different scope from signature picker); the DEFERRED entry was specifically "movie-font signature → professional fonts". |
| Delete the orphan .ttf files? | No. Per CLAUDE.md "Asking permission... Anything that deletes more than one file" — leaving them alone for Nic to git rm if he wants. |

## Carry-forward — S234+

DEFERRED post-S233:

**Open — pickable:**
- E-sign UI bundle: 5 remaining items (witness-in-send-modal,
  tenant draft persistence, decline-with-reason path, view-only
  re-open, initials lock-to-name)
- Owner-vs-manager re-audit of permissions
- POS multi-terminal session sync (likely premature)
- /resolve smoke (testing)
- POS end-to-end smoke (testing)

**Nic-blocked:**
- Marketing AZ-copy review
- pos_tax_rates → cart math (stacking semantics)
- utility_bills payment integration (cycle vs. add-on product call)
- Deposit-interest monthly netting (architecture call — destination
  charges complicate the netting model)
- Owner-financial-escalation pattern
- Primary manager urgency tier

**External-vendor-blocked:**
- Background-check Checkr Partner approval

**Multi-session epics still pending:**
- Flex Suite (3-5 sessions, launch-flag gated)
- Sublease subsystem (3+ sessions, greenfield)
- F1 Marketing rebuild (2-3 sessions)
- POS Stripe Terminal hardware (gating: adapter selection)
- npm audit upgrades (4 packages, breaking jumps each)

**Pre-launch flag-gated build:**
- OTP UI surface + reserve-disbursement
- tenant-pool endpoint refinements

## Revised count

S233 closed 4 line items + 1 sub-item from the e-sign bundle.

| Bucket | Pre-S233 | Post-S233 |
|---|---|---|
| Pickable now | ~10 | ~6 |
| Nic-blocked | 5 | 5 |
| External-vendor-blocked | 1 | 1 |
| Multi-session epics | 3 | 3 |
| npm audit | 4 | 4 |
| Pre-launch flag-gated | 2 | 2 |

**Until v1 launch-ready:** ~15 sessions → ~13.
**Until 100% feature-complete:** ~25 sessions → ~22.

---

End of S233 handoff.
