# SESSION 526 HANDOFF

## Theme
Big session, three arcs. (1) **Permission system FINISHED** — property-scoped
views for locked staff, first-permitted-page login landing, old Team-row grid
retired (StaffPermissionsPage = the one config surface). (2) **Reservations
decluttered + zero platform fee** — create = contact + dates only; 5% booking
fee eliminated (backend too); timeline z-order glitch fixed. (3) **Unit-type
model built out** — type-first Add Unit with sub-types (bedrooms capped at 3,
landlord-entered storage sizes, RV layout/amp), per-property unit-type default
pricing with sub-type overrides, property fee-schedule page RETIRED (fees =
each tenant's signed lease, period), RV sites short+long term by default,
30+/7+ day stays auto-draft a needs_review lease (weekly-lease toggle per
property), Edit Property cleaned (layout fix; FlexCharge + late-fee UI gone).
Eight pre-existing bugs fixed along the way (see sections). Uncommitted (Nic
commits).

**Read sections 1–11 below in order — each is one shipped chunk.**

## SHUTDOWN STATE (end of night)
- 5 migrations applied this session (property_unit_type_pricing,
  units.storage_size, rv bookable backfill, properties.weekly_lease_mode,
  leases booking-draft source). schema.sql regenerated.
- Tests at close: booking-lease-draft (5), schedule-property-scope (11), units,
  units-gap-close, bookings, properties-gap-close, pos-property-scope, scopes —
  all green. Both apps tsc clean.
- Dev servers were started ad-hoc this session (API :4000 ts-node-dev
  background, landlord :3001 under the Claude preview). Mac shutdown kills
  them — next session restart per [[gam-launch-portal-scope]] ("launch set
  only"), or at minimum API + landlord. NOTE: the prod tunnel
  (api.goldassetmanagement.com) points at this Mac's :4000 — it goes dark
  while the Mac is off (pre-launch, acceptable; launchd brings the tunnel back
  on boot but the API must be started manually — dev-stack hardening still a
  launch TODO, see [[gam-prelaunch-todo]]).
- Test accounts: Jane `teststaff-demo@golddoor.io`/asdfasdf (front-desk preset,
  empty landlord); Dana `testdesk-demo@golddoor.io`/asdfasdf (front-desk +
  schedule.create_reservation, james@demo.dev's landlord, locked to Mesa View).
  Demo config kept: Mesa View RV pricing default + pull-through·50 override.
  All test bookings/units created during verification were deleted.

---

## SHIPPED

### 1. Property-scoped VIEWS for property-locked staff (backend)
- New helper `middleware/auth.ts getScopedPropertyIds(user)` — read-side
  companion to `assertPropertyInScope`. Returns `null` = unrestricted (owners,
  all_properties, roles with no scope table), else the scope row's
  `property_ids` (missing row → `[]` = sees nothing, same posture as the POS
  lock). List endpoints splice it in as
  `AND ($n::uuid[] IS NULL OR u.property_id = ANY($n))`.
- Scoped: `GET /units/schedule/master` (units + bookings + leases queries),
  `GET /units/schedule/history`, `GET /bookings`, `GET /bookings/change-requests`,
  `GET /balances`, `GET /units/:id/bookings` (via assertPropertyInScope on the unit).
- **Write-side property lock added too** (fix-it-right): `POST /units/:id/bookings`
  (create reservation) + `PATCH /units/:id/bookings/:bookingId` (edit/move —
  checks BOTH the booking's current property and, on unit swap, the target).
- Read gates added: `GET /bookings` now requires `bookings.view`;
  `/change-requests` requires `bookings.change_requests|resolve_change_request`
  (were ungated reads). SchedulePage's change-requests query now only fires
  when the user holds the key (no 403 noise on the Reservations tab).

### 2. STALE-KEY BUG FIXED — schedule endpoints 403'd the Front Desk preset
`/units/schedule/master`, `/units/schedule/history`, `/units/:id/bookings`
still gated ONLY on pre-catalog keys (`guests.check_in`/`units.view_status`/
`units.edit`) which the permissions page never grants — a front-desk user got
403 on the data behind their own tabs (S525 verified tabs render, not data).
Now gated on the catalog keys (`schedule.tab.*`, `bookings.view`) with the
legacy keys kept for old scope rows.

### 3. BALANCES landlordId BUG FIXED
`routes/balances.ts` used `req.user.profileId` as landlord_id — for staff
that's their USER id, so a worker always got an empty list (S525 verified on
an empty landlord, so it hid). Now resolves `role==='landlord' ? profileId :
landlordId` like the schedule routes.

### 4. Login landing = first permitted page (was hardcoded /pos)
- `Layout.tsx`: visibility rule extracted to exported `visibleNavItemsFor(user)`
  (single source for sidebar + redirect).
- `main.tsx RoleRedirect`: onsite_manager / maintenance / property_manager →
  first visible nav item; **zero grants → new `/welcome` page** (NoAccessPage:
  "no pages enabled yet, ask the owner, re-login to pick them up").

### 5. Old Team-row permission grid RETIRED
- `TeamPage.tsx`: expandable rows GONE (SUB_PERMISSIONS_BY_ROLE checkbox grid,
  inline ScopePicker, DirectDepositToggle all removed). Now roster-only: invite
  form + member rows (click row or "Permissions →" → permissions page) +
  pending invitations + DD-pending KPI. Bookkeeper keeps an inline access-level
  select in the row (no catalog perms).
- `StaffPermissionsPage.tsx` is THE per-user config page: **Property scope**
  card (ScopePicker moved here, "Hard lock" copy) + **Direct Deposit** toggle +
  Connect-requirements modal (PM only, moved) + presets + full catalog.
  SUB_PERMISSIONS_BY_ROLE / SUB_PERMISSION_LABEL no longer imported anywhere
  (shared exports remain).

### 6. Pre-existing red test fixed
`units-gap-close.test.ts` "happy: landlord sets status" sent `suspended`,
which S524 deliberately blocks (coupled to eviction mode) — red since S524.
Now sets `available` + a new companion test asserting suspended → 400.

## TESTS
- New `schedule-property-scope.test.ts` (11): catalog keys grant schedule,
  scoped worker sees only their property across master/bookings/balances/
  history, owner + all_properties see landlord-wide, /bookings read gate,
  reservation create blocked cross-property / allowed in-scope.
- Updated fixtures: units-gap-close PM now has a real user + all_properties
  scope row; bookings 403-test token carries bookings.view so it reaches the
  landlord-scope guard it tests.
- **88 tests / 6 suites pass** (schedule-property-scope, bookings,
  units-gap-close, units, pos-property-scope, scopes). Both apps tsc clean.

## VERIFIED LIVE (browser + API)
- New test staff **Dana Desk `testdesk-demo@golddoor.io` / `asdfasdf`**
  (onsite_manager under james@demo.dev's landlord `806d37f3-…`, front-desk
  perms, property-locked to Mesa View `7bfd8334-…`): login lands on /schedule
  (not /pos), nav = Master Schedule/Leases/Outstanding Balances, schedule shows
  3/9 units (Mesa only, no Oak Street), /bookings Mesa-only, history Mesa-only,
  balances 200. Zero console errors.
- Jane (`teststaff-demo@golddoor.io`) with perms stripped → lands on /welcome
  with the explainer; perms restored to the 11-key front-desk set after.
- Owner: /team rows clean (no expandable), permissions page renders scope card
  ("Save scope" works → "Scope saved."), presets, 105-key catalog, 15 sensitive
  badges.

## BEHAVIOR CHANGES TO FLAG
- Workers with all_properties=false AND empty property_ids now see NOTHING on
  schedule/reservations/balances (were landlord-wide). Same class as the S525
  POS change; pre-launch demo data only.
- `GET /bookings` + `/change-requests` now require the bookings catalog keys
  for staff (were open reads to any authed team member).

## OPS NOTE
API :4000 and landlord :3001 were DOWN at session start (prod
api.goldassetmanagement.com had nothing to route to). Restarted the dev API
(ts-node-dev, background) — tunnel serves again. Landlord :3001 runs under the
Claude preview server. The backend-to-launchd hardening remains a launch TODO
([[gam-prelaunch-todo]]).

### 7. Timeline z-order glitch FIXED (Nic-reported)
When the grid is horizontally scrolled (it auto-scrolls so today is at the
left, with past days in range), past day-cells slide UNDER the sticky
unit-info column — but the column was zIndex 1 vs the bar divs' zIndex 1–2,
so lease/reservation bars painted OVER the unit info. Sticky unit td bumped
to zIndex 3 (header th is 4, bars max 2). Verified in preview: unit 201's
lease bar now clips cleanly at the date grid.

### 8. Reservation creation DECLUTTERED + zero platform fee (Nic directive)
- **Per-unit "+ Book" modal** is now exactly: First name / Last name / Email /
  Phone / Check-in / Check-out (+ "N nights · billed nightly|weekly|monthly"
  hint). REMOVED: single Guest Name (split), Lease Type dropdown (implied by
  stay length ≥30→monthly ≥7→weekly else nightly, clamped to the unit's
  allowed list), Total Amount input (nobody pays on that screen — backend
  prices authoritatively from unit/property rates), Notes, and the
  "Platform fee: 5%" banner. All contact fields now required.
- **"+ New Reservation" flow modal**: unit rows no longer show price/tax —
  just unit info + "Reserve →". RV layout/amp preference filters kept.
- **Booking detail panel**: "Fee: $x" line removed.
- **Backend (`units.ts`): platform_fee = 0 on create AND reprice** (was 5% of
  total). Nic: reservations carry zero fees — GAM's income is the
  $2/occupied-unit monthly fee. units.test.ts fee assertion updated to 0.
- Verified live as Dana: modal shows only the 6 fields; created a real
  reservation → backend priced $336 from unit rates, platform_fee 0.00,
  status confirmed; flow modal shows no dollar amounts. Test booking deleted.
- NOTE: Dana (testdesk-demo) also granted `schedule.create_reservation` (kept —
  fits the front-desk preset's counter workflow; consider adding to the preset).
- Existing bookings keep their old stored 5% platform_fee values (column is
  write-only except displays now removed); reprice zeroes them on touch.

### 9. Unit types + sub-types + type-level pricing; property fee schedule RETIRED (Nic directive)
- **Principle (Nic):** fees bind to the individual tenant's SIGNED lease, never
  property-wide; a change only reaches new leases/renewals. Billing already
  works this way (lease_fees parsed from the executed document at e-sign
  finalize; property_fee_schedules was only the is_override audit baseline).
  So the landlord-facing "Standard Fee Schedule" page section is REMOVED —
  `PropertyFeeScheduleSection` unmounted from PropertyDetailPage (file kept on
  disk); backend fee-schedule routes stay for the esign audit comparison.
- **New `property_unit_type_pricing`** (migration `20260702190000`): per-property
  creation-time pricing defaults per unit type + sub-type overrides.
  subtype_key: '' default · 'bed:<n>' · 'rv:<layout>|<amp>'. Shared:
  `UnitTypePricingRow`, `unitPricingSubtypeCandidates`, `resolveUnitTypePricing`
  (FIELD-LEVEL merge — an override that only sets nightly inherits rent/deposit
  from the type default; returns resolvedFromKey for the prefill label),
  `unitSubtypeLabel`. Routes: GET/POST/DELETE
  `/properties/:id/unit-type-pricing` (POST upserts; properties.edit).
- **`UnitTypePricingSection`** on PropertyDetailPage (replaces the fee section):
  per-type Default row + "+ Sub-type override" rows (bedrooms for
  apartment/SFH/mobile; layout×amp combos for RV; none for storage/commercial).
- **AddUnitModal reworked — TYPE-FIRST:** unit-type card grid → type's
  sub-options (RV: Back-in/Pull-through + 30/50 amp chips, no bed/bath;
  bedroom types: bed/bath/sqft; storage/commercial: sqft) → pricing step
  PREFILLS from the property defaults (shows "Prefilled from your RV Spot ·
  Pull-through · 50 amp pricing") → review shows type + sub-type.
  **POST /units extended**: unitType, rvSiteLayout, rvAmpService,
  nightlyRate/weeklyRate (pre-S526 every unit was born 'apartment').
- **THREE pre-existing bugs fixed in passing:** (a) AddUnitModal's set() used
  snake_case keys ('property_id', 'unit_number', 'rent_amount'…) against
  camelCase state — property selection + several inputs were dead; (b) review
  step showed a hardcoded bogus "Platform fee $15.00/month"; (c)
  PropertyDetailPage passed `data.id` from the FINANCES payload (no id) to the
  fee-schedule + agent-permissions sections → both 500'd with
  propertyId=undefined forever (why the fee page always showed all-unconfigured).
- **VERIFIED live (james@demo.dev / landlord1234, Mesa View):** saved RV
  default (rent 500/dep 300/nightly 45/weekly 250/monthly 750) + pull-through·50
  override (nightly 60 only) → Add Unit picked RV + pull-through + 50 →
  pricing prefilled 500/300/60/250 (merge!) → created → DB row correct
  (rv_spot/pull_through/50 + rates); test unit deleted, pricing rows kept as
  demo config. units + properties-gap-close suites green (41), both apps tsc 0.

### 10. Bedroom cap · storage sizes · RV always-bookable · AUTO LEASE DRAFTS (Nic directives)
- **Bedroom menus cap at 3:** AddUnitModal select = Studio/1/2/3/"4+" (4+ flips
  to a free count input); pricing-override menu lists 0–3 PLUS any count >3
  that actually exists on the property's units (no invented menu entries).
- **Storage sub-types = landlord-entered sizes:** `units.storage_size` (migration
  `20260702200000`), Size input on storage add-unit, subtype_key `size:<value>`
  (e.g. 'size:10x10'), pricing-override picker lists sizes in use + "New size…"
  free entry. Prefill resolver handles it (shared candidates + label).
- **RV sites short+long term BY DEFAULT:** new rv_spot units created
  is_bookable=TRUE with lease_types_allowed {nightly,weekly,month_to_month,
  long_term}; migration `20260702200500` backfilled existing rv_spot units.
- **AUTO LEASE DRAFT for long stays:** stays ≥30 nights (≥7 when the property's
  new `weekly_lease_mode` is on — migration `20260702201000`) draft a lease
  automatically: `services/bookingLeaseDraft.ts maybeDraftLeaseFromBooking`,
  hooked (best-effort) into booking CREATE + PATCH (extensions re-check).
  Draft = pending + needs_review + lease_source 'booking_draft' +
  source_booking_id (migration `20260702201500` adds the column, a unique
  partial index for idempotency, and extends the lease_source CHECK). Rent =
  unit rent_amount (fallback monthly_rate); dates = the stay. Landlord
  completes it (attach tenant, adjust, send for signature) from Leases.
- **Weekly-leases toggle** in the property edit form's Reservation policy
  section (PropertiesPage) → properties.weekly_lease_mode via property PATCH.
- Tests: new `booking-lease-draft.test.ts` (5: <30 no draft, ≥30 drafts w/
  correct fields, extension drafts once-and-only-once, weekly mode drafts at
  7+, storage size + RV defaults on POST /units). 97 tests green across the
  6 affected suites; both apps tsc 0. UI verified in preview (bedroom 4+ menu,
  storage size field, free-size override entry, weekly toggle renders).
- FOLLOW-UPS: (a) draft lease has NO tenant attached (guests have no account)
  — landlord attaches at review; consider a notification when a draft lands.
  (b) LeasesPage may want a "Drafted from reservation" badge for
  lease_source='booking_draft' rows.

### 11. Edit Property cleaned up: layout fix + FlexCharge + late-fee UI REMOVED (Nic)
- **Layout fix:** the modal's old two-column grid (amenity chips crammed beside
  the address fields) → stacked full-width rows: Name / Street+Suite /
  City·State·ZIP / Amenities. Verified in preview.
- **FlexCharge toggle REMOVED** from the property form (not a launch feature;
  nav/route were already LAUNCH_HIDDEN). Backend flexcharge_enabled column +
  routes intact.
- **Late-fee policy section REMOVED COMPLETELY** (S223/S226 UI): late fees are
  charged strictly per each tenant's signed lease — NO landlord-settable
  late-fee knob may exist anywhere that could conflict with the lease.
  VERIFIED the billing engine was already lease-driven: jobs/lateFees.ts reads
  ONLY l.late_fee_* lease columns (properties joined for timezone only).
  Lease-side entry surfaces stay (LeaseFormModal / TenantOnboarding /
  ConfirmIntentModal = transcribing the document's own terms). Property PATCH
  still ACCEPTS the fields backend-side; no UI sends them.
- **Follow-ups from #10 done:** LeasesPage shows a gold "From reservation"
  badge on lease_source='booking_draft' rows; drafting now fires an in-app
  notification to the landlord (type 'lease_drafted_from_booking', best-effort).
- 46 tests green (lease-draft, properties-gap-close, units); both apps tsc 0.

## DEFERRED / NEXT SESSION
1. Cosmetic (UI batch): Master Schedule toolbar (search/stats/+New Reservation)
   still renders above non-timeline tabs.
2. Optional: auto-login on staff accept (accept POST returns no token).
3. FlexDeposit advance→custody code rework (`services/flexDeposit.ts`).
4. Legacy pre-catalog keys (guests.check_in etc.) still honored by requirePerm
   on the schedule/unit-bookings routes for old scope rows — drop once demo
   users are re-granted from the catalog.
5. Stripe still BLOCKED on Nic's sales rep (see [[gam-launch-accounts]]).
6. Property-onboarding bulk add-units flow (PropertiesPage AddUnitsStep) still
   creates type-less units — align it with the new type-first model.
7. Master Schedule "Configure Unit" modal overlaps the new pricing model
   (unit-level rates) — fine (unit copy is authoritative), but consider
   surfacing "differs from your type default" there later.
