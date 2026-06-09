# Session 294 — closed

## Theme

Foundation for the first-5-uploads review system Nic sketched
this morning. Adds `import_extra_data` JSONB overflow columns to
the three CSV-import target tables and reworks the mapping
pipeline so source columns that aren't canonical-mapped AND
aren't on the platform's noise list land in extra_data instead of
being silently dropped. Sets up S295's review queue to surface
exactly what landlords are uploading — including columns we
haven't researched yet.

The product reasoning Nic gave: "we need to map every column. i
dont know why some would be unmapped. even if we dont use
everything now we still want the data." Conservative
implementation: existing IGNORED arrays (already-judged noise)
stay as the discard set; unknown columns from un-researched
platforms or off-template exports now get captured for review.

## Items shipped

### Migration: import_extra_data JSONB on three tables

`apps/api/src/db/migrations/20260516090000_csv_import_extra_data.sql`
adds `import_extra_data jsonb` (nullable, no backfill) to:

- **leases** — tenant CSV writes here per row (one row per CSV
  row creates one lease).
- **units** — property CSV writes here per row.
  Property-level extras (Year Built, Country, etc.) duplicate
  across each unit on a multi-unit property — accepted; extras
  are review-queue data, not query-path data.
- **payments** — payment-history CSV writes per row.

`properties` deliberately NOT touched — property rows are find-
or-create across multiple CSV rows; attaching extras to one
property row would be lossy when 5 CSV rows for the same
property have different extras (or the same; either way, the
unit-level write captures everything correctly).

### applyMapping pipeline: route uncategorized columns to _extra

Three apply* functions in `apps/api/src/lib/csvImportMappings.ts`
(`applyMapping`, `applyPropertyMapping`, `applyPaymentMapping`)
now route non-canonical, non-noise columns to a `_extra` field
on the mapped record. A new private helper `mapWithExtra` does
the per-record work:

```ts
function mapWithExtra(rec, aliasToCanonical, noiseSet) {
  const out = {}, extra = {}
  for (const [key, val] of Object.entries(rec)) {
    const norm = key.trim().toLowerCase()
    if (aliasToCanonical.has(norm))   out[aliasToCanonical.get(norm)] = val
    else if (!noiseSet.has(norm))     extra[key] = val   // original case preserved
  }
  if (Object.keys(extra).length > 0)  out._extra = extra
  return out
}
```

The noise set is built from each platform's existing
`ignoredColumns` config (lowercased). Square's payment-mapping
noise set additionally includes the preprocess's synthesized
`__derived_method` and `__derived_type` helper columns (internal
scaffolding, not real source data).

**Original-case header keys preserved** in `_extra` (not
normalized) so the S295 super admin review queue can show
landlords' exact uploaded shape, not a lowercased version.

### Row-type wiring

`CsvRow` (tenant), `PropertyCsvRow`, `PaymentCsvRow` in
`apps/api/src/routes/landlords.ts` each gain
`extra?: Record<string, any>`. Validate handlers read `r._extra`
off the mapped record and populate `row.extra`. Three sibling
edits.

### Commit-handler wiring

Three commit handlers now write `import_extra_data` JSONB:

- **Property CSV commit** (`POST /api/landlords/me/onboard-
  properties-csv/commit`) — writes `row.extra` to the new
  `units.import_extra_data` column on every unit INSERT.
- **Tenant CSV commit** (`POST /api/landlords/me/onboard-
  tenants-csv/commit`) — writes `primary.extra` to the new
  `leases.import_extra_data` column on the lease INSERT. Co-
  tenant rows' extras dropped intentionally (same lease, same
  shape; primary row wins, mirrors the existing pattern where
  primary.* drives the lease record).
- **Payment CSV commit** (`POST /api/landlords/me/onboard-
  payment-history-csv/commit`) — writes `row.extra` to the new
  `payments.import_extra_data` column on every payment INSERT.

All three use the same null-handling pattern:
`row.extra && Object.keys(row.extra).length > 0 ?
JSON.stringify(row.extra) : null`.

### Test coverage

`apps/api/src/lib/csvImportMappings.test.ts` updated:

- **"unmapped columns are dropped"** test renamed to
  "S294: noise (ignoredColumns) dropped; unknown columns routed
  to _extra" — asserts that platform-noise columns still drop but
  truly-unknown columns now land in `_extra`.
- **"Buildium ignoredColumns are dropped silently"** test
  updated to assert `_extra` is `undefined` when there are no
  unknown columns (proves we don't emit an empty `_extra`
  object).
- **New: "S294: _extra preserves original-case header keys"** —
  verifies that "My Custom Field" stays "My Custom Field" in
  `_extra`, not lowercased.
- **New: "S294: _extra omitted entirely when no unknown
  columns"** — verifies record shape stays clean for the common
  case.

## Files touched (S294)

```
apps/api/src/db/migrations/
  20260516090000_csv_import_extra_data.sql  (new — migration)

apps/api/src/db/
  schema.sql                                (regenerated by runner)

apps/api/src/lib/
  csvImportMappings.ts                      (~+60 lines net —
                                             mapWithExtra helper,
                                             three apply* functions
                                             rewired)
  csvImportMappings.test.ts                 (+2 test cases; one
                                             rename + one assertion
                                             tightened)

apps/api/src/routes/
  landlords.ts                              (3 row-type changes +
                                             3 validate handlers +
                                             3 commit handlers)

SESSION_294_HANDOFF.md                      (this file)
```

## Decisions made during build

| Question | Decision |
|---|---|
| Add `import_extra_data` to all 5 import-target tables (`tenants`, `leases`, `properties`, `units`, `payments`) or a subset? | **3 tables: leases, units, payments.** `tenants` and `properties` are find-or-create across multiple CSV rows; attaching extras to those rows would be lossy. `leases`/`units`/`payments` are 1:1 with CSV rows. |
| Audit each platform's existing IGNORED array to split noise vs real-data this session? | **Defer.** Items currently in IGNORED have already been judged not-valuable in prior sessions. The win this session is capturing UNKNOWN columns from un-researched platforms or off-template exports. Promoting individual IGNORED columns to extra_data can happen per-use-case in future sessions. |
| Per-tenant extras on co-tenant rows — merge or drop? | **Drop co-tenant extras.** Lease record uses `primary.*` for every other field; consistency says primary wins on extras too. The alternative (per-tenant JSONB merging) would risk key collisions and require disambiguation logic with no clear product win — co-tenants on the same lease share the same lease-level facts. |
| Preserve original-case header keys in `_extra` or lowercase them? | **Original case.** The S295 review queue shows the super admin what the landlord uploaded — exact strings matter. The lowercase normalization is only for alias matching at lookup time, not for storage. |
| Square's `__derived_method` / `__derived_type` — let them flow into extra_data? | **No — add to noise set.** These are internal scaffolding from the preprocess hook. They'd be confusing in the review queue. |
| Use `extraction_extras` (the existing JSONB on `leases` for PDF imports) or a new column? | **New column.** Different concerns: `extraction_extras` is PDF-extraction overflow (fields parsed from lease PDFs); `import_extra_data` is CSV-import overflow. Reusing one column would conflate two unrelated flows and break a future migration that wants to drop one. |

## Verification

- `cd apps/api && npx tsc -b` → clean.
- `cd apps/api && npm test` → **228 / 228 passing** (was 226 at
  S294 start; +2 new csvImportMappings.test.ts cases for the
  _extra-preservation behavior). No regressions in the 13
  csvImportPaymentHistory.test.ts, 14 csvImportProperty.test.ts,
  or 9 csvImportTenantBalance.test.ts cases.
- Migration applied via `npm run db:migrate` from repo root;
  runner regenerated `schema.sql` automatically.

## Items deferred (S294-specific carry-forwards)

- **IGNORED-array audit** — items currently in each platform's
  IGNORED array stay there as noise. Future sessions can
  promote specific items to extra_data per use case (e.g., when
  a feature is built that wants Year Built data).
- **Reading extra_data** — no consumer yet. S295's review queue
  is the first reader. Migration data is captured but inert
  until then.
- **GET endpoint to surface import_extra_data on individual
  records** — landlord-facing surface (would let a landlord see
  what extra fields got captured on their imported tenants).
  Defer until there's a UI need; storage works without it.

## Items deferred (cross-session docket, unchanged)

- **S295: First-5 review queue.** `csv_import_attempts` table +
  banner on import-success page + super admin review surface
  showing column headers + sample rows. Reads `import_extra_data`
  to surface the unmapped-column shape.
- **S296: Platform verification lifecycle.** `mapping_status`
  flag on platforms; auto-escalate every upload to super admin
  until verified.
- **S297: Generic claim aggregation + promotion.** Required
  "What platform is this?" text input on generic. Aggregation
  view; promotion → code-change session for Nic.
- **Campground Master import path** when Nic has the sample.
- **2FA fan-out** when admin walkthrough lands.
- **Yardi GL-export columns** (S293 carry-forward).
- **Rentec blank import template** (S293 carry-forward).
- **Lawyer review of ToS** (S291–S293 carry-forward).

## Nic-pending (unchanged)

- Stripe live keys.
- Resend domain verification.
- Plaid production keys.
- Stripe Terminal hardware.
- Checkr Partner credentials.

## What S295 should target

**Build the first-5 review queue.** Concrete scope:

1. New table `csv_import_attempts` — landlord_id, import_type
   ('tenant' / 'property' / 'payment'), platform_key,
   claimed_platform_name (nullable, for future generic flow),
   column_headers (JSONB array — the original-case headers seen
   in the upload), sample_rows (JSONB — first 5 rows raw),
   row_count, blockers_count, warnings_count, reviewed_by
   (nullable uuid → users), reviewed_at, status
   ('pending' / 'reviewed').
2. Validate handlers append a `csv_import_attempts` row alongside
   the existing validate response. Commit handlers update the
   row with row_count + status='pending'.
3. Per-platform per-import-type counter query: when count ≤ 5,
   include `firstFive: true, position: N` in the validate/commit
   response.
4. Banner on `PaymentHistoryOnboardingPage`,
   `PropertyOnboardingPage`, `TenantOnboardingPage` when
   `firstFive` is true: "You're one of the first to migrate
   from [Platform]. Our team will double-check the mapping
   landed cleanly and follow up if needed."
5. Super admin review surface (new admin page): list of pending
   attempts, columns + first-5 sample rows visible, "mark
   reviewed" action. Probably in `apps/admin` (super_admin only,
   not the slim admin-ops surface).

S295 reads `import_extra_data` to surface the unmapped-column
shape on already-committed imports (the "what got captured but
not mapped" view).

---

End of S294 handoff. Closed clean.
