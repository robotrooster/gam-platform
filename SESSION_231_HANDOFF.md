# Session 231 — closed

## Theme

Per-platform CSV import mapping framework. The
`/onboard-tenants-csv/{validate,template}` pair has been live since
S29c with `source` plumbed through but only `'generic'` accepted —
non-generic requests rejected with an explicit "coming soon" message
naming Buildium / AppFolio / DoorLoop / etc., and the frontend
PLATFORM_OPTIONS list had all 8 of those platforms with
`enabled: false`. S231 builds the registry that translates a
competitor's column names to GAM's canonical headers, and ships
Buildium as the first enabled mapping.

## Recon finding

Two stale DEFERRED entries discovered + cleared as part of recon
pre-flight:

- **POS End-of-day reconciliation report + cron** — already shipped
  at S95. `services/posEod.ts:generateEodForAllActiveLandlords` runs
  via the 3:30am Phoenix cron at `jobs/scheduler.ts:876-892` against
  the `pos_eod_settlements` table. Manual close + regen + history
  endpoints all live at `routes/pos.ts:939-1021`.
- **Per-state tax form catalog** — already shipped at S203/S204/S205.
  `state_tax_forms` table has 69 forms across 38 states (verified via
  psql); books portal consumes `filingDeadlines` from
  `routes/books.ts:1265-1271` via the `getApplicableTaxForms`
  service; UI at `apps/books/src/main.tsx:1704`.

Both removed from `DEFERRED.md` "Open" section in this session
(no closed-tombstone — the original DEFERRED entry was the
tombstone-eqivalent; just dropping the line).

## What S231 shipped

### Backend — `apps/api/src/lib/csvImportMappings.ts` (new file)

A platform-keyed registry that translates source-platform CSV column
headers to GAM's canonical generic headers before validation runs.
Module exports:

- `GAM_CANONICAL_HEADERS` — the 15 generic GAM headers (single
  source of truth; `landlords.ts` no longer redeclares them).
- `CsvImportPlatform` type — union of the 9 supported platform
  values (`generic` + 8 competitor platforms).
- `isCsvImportPlatform(s)` / `isPlatformEnabled(p)` —
  type-guard + flag helpers.
- `applyMapping(records, platform)` — case-insensitive header
  rewrite. First alias of each canonical field wins on collisions.
  Unmapped columns are silently dropped (Buildium `Status`,
  `Account Balance`, etc. don't pollute the validator output).
- `buildTemplateCsv(platform)` — generic returns canonical headers
  + example row (unchanged from pre-S231); enabled platforms return
  the platform's preferred header names so the landlord can
  cross-reference against their export.

Platform table (initial state):

| Platform     | Enabled | Notes |
|---|---|---|
| `generic`    | ✓ | GAM canonical |
| `buildium`   | ✓ | Reports > Tenant List > Export |
| `appfolio`   |   | stub mapping; needs real export sample |
| `doorloop`   |   | stub mapping |
| `yardi`      |   | stub mapping |
| `rentmanager`|   | stub mapping |
| `propertyware`|  | stub mapping |
| `rentec`     |   | stub mapping |
| `tenantcloud`|   | stub mapping |

Buildium mapping covers 12 of 15 canonical fields (skips
`auto_renew` / `auto_renew_mode` / `notice_days_required` — Buildium
doesn't expose these in tenant exports; landlord fills in or accepts
GAM defaults at the row-edit step in TenantOnboardingPage).
`BUILDIUM_IGNORED` lists known-extra columns from Buildium exports
that we silently drop (Status, Account Balance, Lease Type, etc.) —
documents intent so a future audit doesn't wonder why these aren't
mapped.

### Backend — `apps/api/src/routes/landlords.ts`

- Imported `applyMapping` / `buildTemplateCsv` / `isCsvImportPlatform`
  / `isPlatformEnabled` from the registry.
- Removed local `CSV_GENERIC_HEADERS` const (now lives in registry).
- `GET /onboard-tenants-csv/template` now per-platform: validates
  source, returns the platform's CSV template via `buildTemplateCsv`.
  Filename suffixed with the platform slug for non-generic.
- `POST /onboard-tenants-csv/validate` now: validates source, parses
  the CSV, runs `applyMapping` to normalize headers, then proceeds
  through the unchanged validator. The validator key set was already
  expecting canonical names — the only change is what's in `records`
  before that loop runs.

The S29c "only generic supported" guard is gone; the new guard rejects
any platform that's not in the registry OR is in the registry but
flagged `enabled: false`, with a copy-friendly message that points
the landlord at the Generic option as the workaround.

### Frontend — `apps/landlord/src/pages/TenantOnboardingPage.tsx`

- `PLATFORM_OPTIONS[buildium].enabled` flipped from `false` to `true`.
- Template download URL now passes `source=${selected}` instead of
  the hardcoded `source=generic`. Filename matches.
- Step 2 ("Get the template") helper text + button label both swap
  conditionally: generic shows "Download template" + GAM-template
  instructions, non-generic shows "Download column reference" +
  platform-specific export instructions ("Export from Buildium:
  Reports > Tenant List > Export to CSV…").

### Files touched (S231)

```
apps/api/src/lib/csvImportMappings.ts      (NEW, 203 lines —
                                            registry + applyMapping
                                            + buildTemplateCsv)

apps/api/src/routes/landlords.ts           (+ 5-line import,
                                            - 7-line CSV_GENERIC_HEADERS,
                                            ~ /template endpoint
                                              (per-platform output),
                                            ~ /validate endpoint
                                              (applyMapping pre-step))

apps/landlord/src/pages/
  TenantOnboardingPage.tsx                 (~ buildium enabled,
                                            ~ download URL = ${source},
                                            ~ step 2 conditional copy
                                              + button label)

DEFERRED.md                                (- 'Per-state tax form
                                              catalog' (shipped S203-205),
                                            - 'POS end-of-day
                                              reconciliation report
                                              + cron' (shipped S95))
```

### Verification

- `cd apps/api && npx tsc --noEmit` → clean.
- `cd apps/landlord && npx tsc --noEmit` → clean.
- `cd apps/landlord && npx vite build` → built clean (2.20s).
- End-to-end mapping smoke test: parsed a Buildium-style CSV with 12
  source columns (including `Status`), confirmed `applyMapping`
  produced records keyed by canonical names, with `Status` dropped.
- No backend route shape changes — `/validate` returns the same
  `{ rows, summary }` payload, `/template` returns a different CSV
  body when `source != 'generic'` but the response shape (text/csv,
  attachment header) is unchanged.
- No new migrations.

## Decisions made (S231)

| Question | Decision |
|---|---|
| Build the framework + ship N platforms, or build the framework only? | Framework + Buildium (1 platform). Buildium is documented enough to write a real mapping without needing a sample CSV; the others (AppFolio / Yardi / DoorLoop) need an actual export to map accurately. Stub entries are in the registry so adding a real mapping later is a one-block diff per platform. |
| Translate at parse time vs. add platform-specific validators? | Translate. The validator already reads canonical keys; renaming the keys upstream is a 5-line change. A separate validator per platform would mean 8 parallel branches of logic, which would drift out of sync. |
| Strict platform-name allowlist vs. accept anything and lookup later? | Strict allowlist via `isCsvImportPlatform`. Returns 400 on unknown platform. Allows the registry to be the source of truth for what's supported. |
| Case-sensitive vs. case-insensitive header matching? | Case-insensitive on whitespace-trimmed strings. Real-world platform exports are inconsistent on capitalization ("First Name" vs "first name" vs "FIRST_NAME"); insensitive matching prevents one-off "GAM doesn't recognize this column" support tickets. |
| Drop unrecognized columns vs. preserve them? | Drop. The validator only reads canonical keys; preserving them just inflates the records' memory footprint with no consumer. `BUILDIUM_IGNORED` documents which extra columns we know about + intentionally drop. |
| Buildium template comment line (`# Use Buildium > Reports...`) vs. UI hint? | UI hint. A `#` line in the CSV would break round-tripping if the landlord edited and uploaded the template; the same instruction in the page copy works without that risk. |
| Frontend `PLATFORM_OPTIONS` from API call vs. hardcoded list? | Hardcoded for now. One-platform-per-session cadence means the UI list updates infrequently; an API call adds a network hop on every page load. If the list grows volatile, swap to a `GET /platforms` endpoint that returns the registry's `listPlatformMeta` (already designed but kept out of this session). |
| Generic template still ships an example row? | Yes, unchanged from S29c. New users (no platform) need the example to know the format; platform-specific users export from their platform and don't need an example. |

## Carry-forward — S232+

### Add the next platform

Each platform's mapping is one block in `csvImportMappings.ts`:
flip `enabled: true`, fill in the alias arrays for each of the 15
canonical fields, optionally populate `ignoredColumns` + `notes`.
Then bump the same platform in `PLATFORM_OPTIONS` on
`TenantOnboardingPage.tsx`. Roughly half-session per platform —
most of the time goes into finding a real export sample to
verify column names.

Suggested ordering by likely customer mass: AppFolio → DoorLoop
→ Yardi (these three dominate small/mid landlord market) → the
rest as demand surfaces.

### Already-known carry-forward (unchanged)

See `DEFERRED.md` "Open — pick one" section for the current queue.

---

End of S231 handoff.
