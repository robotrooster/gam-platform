# SESSION 550 HANDOFF

## Theme
OAK PARK LAUNCH SPRINT DAY 1. Nic's directive: Oak Park tenants logged
in + paying rent before Aug 1; HARD SCOPE FREEZE on everything else
until after Aug 1. **The living launch checklist is
`~/gam/OAK_PARK_LAUNCH.md` (N1–N6 Nic / C1–C8 Claude, statuses
inline) — read it right after this file; it carries the full detail
of everything below.** This session shipped: test-data purge +
property-identity safeguards, real-address verification, the entire
growth/data-telemetry foundation (Nic: "the data is the asset for an
eventual buyer"), and the API PRODUCTION FLIP (done + verified).

## State of the launch (end of day 7/20)
- DONE: C1 prod flip, C2 env audit, N6 purge (+safeguards),
  address verification, growth telemetry, audit journal, product
  events. All live-verified.
- NIC's CRITICAL PATH: N1 Stripe live keys (sales-rep/account
  migration) — everything payment-side waits on it. N2 real Oak Park
  landlord account (real business email — tell Claude which). N3
  manual data entry (HIS alone; Claude never pre-loads/edits — C7 is
  read-only QA behind him). N4 Connect KYC after keys. N5 Vercel Pro
  (now unblocked).
- CLAUDE next: C3 Stripe wiring the moment keys land (incl. RAW
  webhook payload storage — data-completeness commitment), C4
  live-fire money test, C5 invite→login→pay walkthrough on prod, C6
  Aug-1 billing dry-check, C7 rolling QA, C8 launch-day watch.

## 1. THE API IS NOW A PRODUCTION SERVICE — biggest workflow change
- com.gam.api launchd service: `node apps/api/dist/index.js`,
  NODE_ENV=production, KeepAlive (verified: kill -9 → respawned +
  serving <6s), WorkingDirectory apps/api (.env + uploads resolve).
  Installer: `bash ~/gam/install-services.sh` (idempotent; --all
  refreshes every plist). start-launch-set.sh no longer kills :4000
  and kickstarts com.gam.api instead of starting a dev API.
- **API code changes NO LONGER hot-reload.** To ship an API change:
  `cd apps/api && npm run build` then
  `launchctl kickstart -k gui/$(id -u)/com.gam.api`.
  To run watch-mode for a dev session:
  `launchctl bootout gui/$(id -u)/com.gam.api` first (else KeepAlive
  fights you), re-bootstrap after. Notes in the plist comment.
- .env (Nic-approved read+write this session): five *_APP_URL values
  flipped localhost → production domains (emails now carry real
  links); ENCRYPTION_KEY generated + added (prod fail-fast in
  routes/background.ts refused to boot without it — guard worked).
  Pre-change .env backup: /tmp/gam-env-backup-*.
- Verified end-to-end: real login through
  https://api.goldassetmanagement.com; marketing + tenant SPA 200
  via tunnel; portals on Vercel already pointed at the prod API;
  nightly backups current (DB dump + uploads, 3:30am, iCloud copy).

## 2. Oak Park test data PURGED + property-identity safeguards
- The 32-unit "Oak Park Motel and RV" under realestaterhoades@gmail.com
  was a DoorLoop rent-roll TEST import (wrong account, inaccurate) —
  deleted with dependents; ZERO Oak Parks in DB. Nic rebuilds manually
  under the real business account (N2/N3).
- Identity rules (iterated with Nic to final form): the FULL ADDRESS
  incl. suite line (street2) is the property.
  * Same landlord + same name + same full address → 409 "entered
    twice". Same landlord, same name, DIFFERENT address → allowed
    (he can own two "Oak Park"s).
  * DIFFERENT account at the same street+suite (ANY name) → blocked
    claim: 409 revealing nothing about the owner + admin alert
    'duplicate_property_claim'. Strip-mall case: different suite →
    allowed (still lands in the fuzzy duplicate-address admin-review
    flag). Co-owners get added as USERS, never a rival record.
  * Enforced on POST /properties AND the CSV import path (same-
    landlord name+address match in CSV = attach to existing).
- Lease imports: no more LIMIT 1 — ALL same-named candidates fetched;
  the STREET NUMBER on the lease picks the property
  (pickCandidateByAddress; ambiguous → clear 409, never a guess).
  streetNumbersConflict guards the single-match case; leading-number
  only ("Highway 89 frontage" is not a street number).
- Storefront slugs: GET booking-config now returns suggestedSlug =
  name+city ("oak-park-yarnell"), street number on collision
  ("oak-park-22658"); SchedulePage prefills blank slug fields.

## 3. Address verification (real-world, graded; never blocks)
- properties + latitude/longitude/address_verification/verified_at.
  services/addressVerification.ts: 'parcel' (street number + street
  token vs the 3.4M-parcel AZ gam_properties DB via propertiesDb —
  the anti-typo tier; real 22658 verifies, typo 22656 cannot; county
  situs city/zip is UNRELIABLE so parcel-miss never downgrades),
  'geocoded' (services/geocoder Nominatim; lat/lon stored),
  'unverified' (creates + 'unverified_property_address' admin alert).
- Wired post-commit (fire-and-forget) on POST /properties + CSV;
  nightly 4:00am sweep (sweepUnverifiedAddresses) retries
  never-attempted + weekly-retries unverified → EVERY property ends
  up with coordinates (heat-map guarantee). Existing rows backfilled
  live (2 geocoded; fake demo Oak St correctly unverified+alerted).
- Vitest guard: verifyPropertyAddress no-ops under VITEST unless deps
  injected (route suites must never hit live geocoder/parcels).
- Ownership proof (parcel owner-name vs landlord identity) =
  post-launch roadmap; parcel DB has owner names.

## 4. Growth + data telemetry ("track every data point")
- platform_growth_snapshots: nightly 4:10am, per-(date,state,city) +
  '*','*' totals row (distinct landlord counts don't sum) — landlords/
  properties/units/occupied/vacant/leases/tenants/rent-roll +
  engagement columns (DAU/WAU/MAU + tenant/landlord-side 30d) on the
  totals row. property_growth_snapshots: per-property daily (finest
  grain; landlord/geo rollups derive) + delinquent/suspended units,
  open maintenance, outstanding balance → powers "70% occupancy when
  you migrated, 85% now" landlord reports.
- Multi-tenant leases count rent ONCE (tested). DEMO EXCLUDED:
  landlords.is_demo (james@demo.dev flagged) filtered from geo/total
  snapshots; engagement excludes dev email domains + test%@golddoor.io.
  Today's rows recaptured clean: REAL platform = 0 landlords, 0 units
  — the growth curve starts at true zero; Oak Park = first real point.
- audit_row_changes: DB-trigger change journal, **109 tables** — every
  UPDATE/DELETE stores the full old row (jsonb); no code path can
  skip it. users journaled via REDACTING trigger (password/totp/token
  fields stripped pre-write — proven). Excluded BY DESIGN: bank/plaid
  + token/invitation tables (secrets), append-only ledgers/logs,
  state-law catalogs, fitness side apps, background_checks (pending
  PII review). STANDING RULE: every new table ships with a journal
  trigger unless append-only/secret/catalog.
- product_events + POST /api/telemetry/events (optionalAuth inline,
  never errors): page_view wired via TelemetryPing in tenant +
  landlord portals; LOGIN events persisted server-side in auth.ts
  (last_login_at overwrites — history only via these rows).
- Honest limits (told Nic): daily-grain snapshots (row journal covers
  finer), page-views-only behavior v1, server request logs stay
  file-based, raw Stripe webhook storage lands with C3.

## Decisions (Nic, this session)
- Scope freeze until Aug 1; launch = login + pay rent only.
- Data entry for Oak Park is manual, his, one unit at a time.
- Property identity = name + full address (suite-aware); co-owners
  join as users on the primary account.
- Cost posture: today $0; only new launch bill = Vercel Pro (~$20/mo,
  his click); Resend Pro ($20/mo, NO daily cap, 50k/mo) only needed
  past ~100 occupied units (free tier: 3k/mo + 100/day); Cloudflare
  $0 indefinitely.
- The data asset is an acquisition-value priority — completeness over
  minimalism, history starts pre-launch.

## Files touched (S550)
Migrations (ALL applied; verify: schema_migrations DESC LIMIT 12):
20260720120000 address verification cols, 20260720140000 platform
growth snapshots, 20260720160000 property snapshots, 20260720160100
engagement cols, 20260720180000 audit journal (17 tables + fn),
20260720180100 product_events, 20260720190000 journal completeness
(users-redacted + scopes + 11 more; note: fixed pre-apply —
'unit_entry_requests' not 'entry_requests'), 20260720190100
landlords.is_demo, 20260720200000 journal final pass (~69 tables).
api NEW: services/addressVerification.ts (+test),
services/growthSnapshots.ts (+test), routes/telemetry.ts.
api EDIT: routes/properties.ts (identity rules + verification hook),
routes/landlords.ts (CSV identity + verification), jobs/leaseParser/
resolveIntent.ts (candidates + pickCandidateByAddress +
streetNumbersConflict + leadingStreetNumber, +test file),
routes/propertyBookingAdmin.ts (suggestBookingSlug), routes/auth.ts
(login event), jobs/scheduler.ts (4:00 sweep + 4:10 snapshot),
index.ts (telemetry mount), test/dbHelpers.ts (journal cleanup).
landlord: SchedulePage (slug prefill), main.tsx (TelemetryPing).
tenant: main.tsx (TelemetryPing). Root: OAK_PARK_LAUNCH.md,
com.gam.api.plist, install-services.sh, start-launch-set.sh edit.
Memory: oak-park-launch-sprint.md added + MEMORY.md indexed.

## Watchouts
- **API changes need build + kickstart now** (see §1) — the #1 trap
  for the next session.
- Suites green at close incl. post-journal (properties 35,
  depositReturn, growthSnapshots, addressVerification, auth,
  resolveIntent, propertyBookingAdmin, landlords-csv). cleanupAllSchema
  now clears audit_row_changes.
- Journal noise: tables with auto-updated_at triggers journal every
  touch (cron touches included) — harmless, by design.
- Telemetry route swallows ALL errors (returns success) — by contract.
- Fitness/side-app and *_archive tables intentionally unjournaled.
- realestaterhoades@gmail.com is NOT flagged is_demo (Nic's; owns
  nothing) — flag if he designates it test-only after N2.
- Public Nominatim = 1 req/s politeness; GEOCODER_URL env can point
  at self-hosted later; sweep is sequential + capped 300/run.
- Next session: START at OAK_PARK_LAUNCH.md; if Stripe keys have
  landed, C3 is the whole day.
