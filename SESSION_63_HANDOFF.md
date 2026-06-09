Session 63 Handoff — schema.sql regeneration + leases enum drift retrofit (Batch 1A)

Date: May 1, 2026

S63 was the 63rd chat. Clean increment from S62. Two DEFERRED items
closed: 21 (schema.sql regeneration) and 18 Batch 1A (AUTO_RENEW_MODES
consumer drift). Two clean tsc passes per touched workspace at every
checkpoint.

WHAT SHIPPED — code

apps/api/scripts/dump-schema.sh (NEW, ~50 lines)
  Bash wrapper around `pg_dump --schema-only --no-owner --no-privileges`.
  Reads DATABASE_URL env with localhost dev fallback. Prepends honest
  GAM "AUTO-GENERATED SNAPSHOT" header pointing to migrations as
  schema-change source of truth and identifying this file as
  current-state source of truth. Writes via mktemp + mv (atomic).
  Single source of regen logic — three callers (CLI, npm script,
  migrate.ts hook) all hit this one script.

apps/api/package.json
  Added "db:dump-schema": "bash scripts/dump-schema.sh" to scripts
  block. Sits alongside existing dev/build/start/migrate/seed/
  schema:diff entries.

apps/api/src/db/migrate.ts
  Added spawnSync import from child_process between crypto and pg.
  Added regenerateSchemaSnapshot() — invokes dump-schema.sh via
  spawnSync. Three failure modes, all warn-and-continue:
    - script missing on disk → warn, exit zero
    - pg_dump errors (non-zero exit) → warn, exit zero
    - exception thrown → warn, exit zero
  Migration success path is NEVER blocked by dump failure (the
  migration succeeded; just the snapshot is stale, recoverable via
  manual `npm run db:dump-schema`).
  Hook fires at end of cmdMigrate after successful pending-migration
  apply. Does NOT fire on --status (read-only) or --mark-applied
  (bootstrap, no schema change).

apps/api/src/db/schema.sql
  Regenerated once at ship time. Drift cleared. File grew 4993 → 5386
  lines — recovery of accumulated drift across 4 unsynced migrations
  (background-check subsystem, AZ defaults strip, bg_check_fee drop,
  azroc rename). bg_check_fee references at S62-noted lines 919-920
  are gone. New header tells the truth about how the file is
  maintained. File mode is -rw------- (mktemp default on macOS) —
  noted in DEFERRED but not blocking; one-line fix in dump-schema.sh
  if it ever bothers a team setup.

apps/api/src/db/migrate.ts.s29c2g.bak DELETED
apps/api/src/db/schema.sql.s29c2g.bak DELETED
  Stale S29c-2-G backups. Not referenced by anything.

5 files retrofitted to consume @gam/shared enums (Item 18 Batch 1A):

apps/api/src/routes/landlords.ts
  Added new @gam/shared import: AUTO_RENEW_MODES.
  Two sites (lines 473, 1489) had inline
  ['extend_same_term', 'convert_to_month_to_month'] arrays for
  auto-renew mode validation. Both replaced with
  (AUTO_RENEW_MODES as readonly string[]).includes(...). The cast is
  required because the readonly tuple's literal type rejects generic
  string in .includes() at line 1489 where row.autoRenewMode is
  SQL-row-typed string. tsc caught the difference and the cast fixes
  both sites consistently.

apps/landlord/src/pages/LeaseFormModal.tsx
  Extended @gam/shared import to include AUTO_RENEW_MODES +
  AUTO_RENEW_MODE_LABEL.
  Inline dropdown options (lines 406-407) replaced with
  AUTO_RENEW_MODES.map(value => ({ value, label, desc })) where label
  comes from the shared map and desc from a new local
  AUTO_RENEW_MODE_DESC: Record<AutoRenewMode, string> map.
  Per-screen UX copy stays local — see decisions section.
  Form-default literals on lines 64 + 86 ('extend_same_term' as
  AutoRenewMode initial state) intentionally untouched — readability
  trade-off.

apps/landlord/src/pages/ConfirmIntentModal.tsx
  Multi-line @gam/shared import extended with AUTO_RENEW_MODES.
  Dropdown options use AUTO_RENEW_MODES.map(m => ({ value: m,
  label: m.replace(/_/g, ' ') })) — matches the snake-replace
  convention used by the file's adjacent LEASE_TYPES and
  SUBLEASING_POLICIES dropdowns. Visible side effect: 'month-to-month'
  hyphen drops to 'month to month' to match the prevailing pattern.
  File-local convention won over hyphen preservation.

apps/landlord/src/pages/TenantOnboardingPage.tsx (NEW @gam/shared
consumer)
  Added: import { AUTO_RENEW_MODES, AUTO_RENEW_MODE_LABEL } from
  '@gam/shared'.
  Dropdown options use AUTO_RENEW_MODES.map(m => ({ value: m,
  label: AUTO_RENEW_MODE_LABEL[m] })) — capitalized labels per the
  file's hand-written-label convention (different from
  ConfirmIntentModal's snake-replace pattern). Sentinel '— select —'
  row preserved before the spread.

apps/landlord/src/pages/SchedulePage.tsx
  Local const renamed: LEASE_TYPES → SCHEDULE_BOOKING_TYPES (2 sites).
  Identifier-collision prevention. Local const had drifted vocabulary
  ('nightly', 'weekly', 'month_to_month', 'long_term') that does NOT
  match leases.lease_type CHECK. Values intentionally untouched —
  full reconciliation belongs to the Master Schedule subsystem
  session (item 11). The value-reconciliation and identifier-
  collision concerns are decoupled deliberately.

WHAT SHIPPED — docs

DEFERRED.md updates (4 items touched):

Item 11 (Master Schedule) — added S63 drift findings sub-bullet
  pointing to apps/api/src/routes/units.ts:180-184 (LEASE_TYPES_BY_
  UNIT_TYPE-shaped map keyed by 'residential'/'rv_spot'/'storage'/
  'parking'/'short_term_cabin' with pre-S24 booking vocabulary
  'nightly'/'weekly'/'month_to_month'/'long_term') and
  apps/landlord/src/pages/SchedulePage.tsx (renamed-to-
  SCHEDULE_BOOKING_TYPES + LEASE_TYPE_LABELS map, both pre-S24
  vocabulary). To be reconciled with unit_bookings.booking_type
  when the Master Schedule subsystem session lands.

Item 18 (CHECK constraint centralization) — Batch 1 section rewritten
  with the audit finding ("centralization is already done — all 9
  leases CHECKs map to existing exports — real work is consumer drift
  retrofit"). Batch 1A marked SHIPPED with full file-level summary.
  Batch 1B scoped for the LEASE_STATUSES + late-fee-triplet enums
  whose values overlap with other domains (global grep too noisy —
  file-by-file required).

Item 20 (bg_check_fee drop) — stale "schema.sql:919-920 still
  references the dropped columns" sub-note removed. No longer true
  post-S63 regen.

Item 21 (schema.sql regeneration script) — marked [SHIPPED — S63]
  with full implementation summary: script path, npm command,
  migrate.ts hook + failure semantics, bundle decision (stayed at
  apps/api/src/db/), drift outcome, .bak cleanup, mode-flag note.

ARCHITECTURAL DECISIONS LOCKED

schema.sql lives at apps/api/src/db/, not docs/ (S63)
  Bundle decision: keep co-located with migrate.ts (the regenerator)
  and migrations/ (source of truth for change history). docs/ would
  create a directory for one file with no clear second occupant.
  The "this is a snapshot, not source code" semantics are already
  shouted by the file's header text — moving doesn't add clarity
  that text doesn't already provide.

Schema regeneration is fail-soft, never fails migrations (S63)
  If migrate.ts's invocation of dump-schema.sh fails for any reason
  (script missing, pg_dump errors, exception), the migration run
  still exits zero. The migration is the important thing; a stale
  snapshot is recoverable. Different failure modes treated identically:
  warn loudly, continue. The only thing that fails the migrate run is
  a migration itself failing.

Per-screen UI copy stays local; cross-app label maps live in shared
  (S63)
  AUTO_RENEW_MODE_LABEL (capitalized 'Extend same term' etc.) is the
  canonical display label across the app and lives in @gam/shared.
  Per-screen description text (e.g. LeaseFormModal's longer
  "Add another term of the same length..." help text) stays as a
  local map keyed off the shared enum. Forcing all UI copy into
  shared would either bloat shared with screen-specific text or pick
  one screen's copy and call it canonical.

File-local label convention beats global label convention when
  retrofitting (S63)
  Three files needed AUTO_RENEW_MODES retrofit. Each picked a different
  label strategy because each file's prevailing pattern differed:
    LeaseFormModal — capitalized label + local desc map
    ConfirmIntentModal — snake-replace transform (matches adjacent
      LEASE_TYPES/SUBLEASING_POLICIES dropdowns in same file)
    TenantOnboardingPage — capitalized label only (matches
      hand-written labels on adjacent dropdowns)
  Imposing one strategy across files would have broken visual
  consistency within at least one file. Match the file you're in.

Identifier collision IS drift, even when value reconciliation is
  deferred (S63)
  SchedulePage had a local LEASE_TYPES const with values that predated
  the unit_bookings split. The values' reconciliation belongs to the
  Master Schedule session (item 11) — but the identifier collision
  with shared LEASE_TYPES is a footgun: a future import of the real
  LEASE_TYPES into this file would silently shadow. Renaming to
  SCHEDULE_BOOKING_TYPES at S63 closes the collision without taking
  on the values reconciliation. Decoupling those two concerns is
  the pattern.

NEW FINDINGS WORTH HANDOFF EMPHASIS

S23d Tier 1 enum centralization went further than the "3 enums"
  memory recorded.
  S62 carried the framing "9 leases CHECKs, 3 already centralized
  (UNIT_STATUSES, UNIT_TYPES, LEASE_DOCUMENT_TYPES)." S63 audit found
  ALL 9 leases CHECKs already have shared exports: LEASE_TYPES,
  LEASE_STATUSES, LEASE_SOURCES, LATE_FEE_AMOUNT_TYPES (×3),
  LATE_FEE_ACCRUAL_PERIODS, AUTO_RENEW_MODES, SUBLEASING_POLICIES.
  The "3" was relative to a specific S23d Tier 1 list that wasn't
  preserved on disk; subsequent sessions silently extended the
  centralization. Real work for Batch 1 was consumer drift retrofit,
  not new exports. Item 18 reframed accordingly.

Audit-pattern lesson: verify before assuming, same shape as S62 Pass 1.
  S62's PERMISSIONS_AUDIT.md false-start happened because the recon
  assumed middleware-coverage gaps without grepping router.use across
  all files. S63's Item 18 false-framing happened because the recon
  assumed centralization gaps without reading packages/shared/src/
  index.ts in full. Same pattern. The fix in both cases: audit
  against ground truth FIRST, reframe the work to match, THEN patch.
  Standing rule worth carrying: when picking up an item from
  S62-or-earlier memory, the first action is recon to verify the
  scope is what memory says it is. Memory is a starting point,
  not a spec.

Token-overlap drift requires file-by-file reads, not global greps.
  Batch 1A worked cleanly because AUTO_RENEW_MODES values
  (extend_same_term, convert_to_month_to_month) are unique to that
  domain. Batch 1B's enums — LEASE_STATUSES (pending/active/
  expired/terminated) and the late-fee triplet (flat/percent_of_rent/
  daily/weekly/monthly) — overlap with unit statuses, invoice
  statuses, billing periods, accrual configs across the codebase.
  Global grep produces too much noise. Batch 1B requires a
  candidate-file list built first via per-file reads of suspected
  sites, then targeted patching.

NUMBERING

S63 was the 63rd chat. Session count = chat count, clean increment.
Next is S64.

CONTEXT NOTE

Session ran clean. One pre-flight abort caught a bad recon assumption
(routes/landlords.ts had no @gam/shared import despite being a
suspected drift site — not in S62's recorded consumer list). Aborted
before partial state, re-recon'd, recovered with the original
patch goal intact. All other patches went single-shot with passing
pre-flight assertions. tsc clean after every patch batch in both
apps/api and apps/landlord workspaces. No half-finished work, no
broken state at any checkpoint. Context did not approach the 50%
warning threshold.

NEXT SESSION CANDIDATES

In rough foundational-leverage order:

1. Item 19 — email systems consolidation. Resend vs nodemailer + npm
   audit blockers. Decision-shaped: needs Nic's call on which sender
   stays. Blocks Item 2 (adverse-action notice) and Item 3
   (books-invite) downstream. Highest blocker for downstream feature
   work.

2. Item 17a Pass 2 — security audit by-file. Per-resource scope
   filtering on writes; retrofit existing inline scope checks to use
   scope.ts helpers (sites: properties.ts:98, units.ts:60,
   units.ts:157, leases.ts:111). Apply S62's lesson: full read of each
   route handler body, not first-N-lines sampling. Per the DEFERRED
   note, ideally lands AFTER 16a managed_by_user_id schema work if
   that affects scope shape.

3. Item 18 Batch 1B — leases token-overlap enums (LEASE_STATUSES +
   late-fee triplet). Build candidate file list first via per-file
   reads of suspected sites (routes/leases.ts, routes/payments.ts,
   leaseParser/extractors.ts, scheduler.ts, invoiceGeneration.ts,
   etc.). Lower priority than 19 or 17a — Batch 1A unblocked the
   highest-leverage drift.

End of S63 handoff.
