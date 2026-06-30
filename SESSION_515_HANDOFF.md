# SESSION 515 HANDOFF

Theme: **Two net-new launch features (amenity reservations + utility-outage
broadcasts) + a sustained pass through `WALKTHROUGH_CHANGES.md`.** All work
uncommitted (Nic decides commits). Two migrations this session, both applied
+ schema.sql regenerated. Everything builds green; new suites pass.

---

## A. Common-area reservations + amenity alerts — SHIPPED, green

Nic asked for (1) residents reserving common areas (clubhouse/pool/pavilion for
parties) and (2) amenity-unavailability notifications. They're one subsystem: a
reservation/closure going live fans out an "amenity unavailable" alert to the
property's active residents.

- **Migration `20260625120000_common_areas_and_reservations.sql`** (applied):
  `common_areas` (reservable/announce-only, requires_approval, capacity,
  reservation_fee, open/close, max hours, advance days) + `common_area_reservations`
  (kind, status, starts/ends, guest_count, notify_residents, decision fields).
- **Shared (`packages/shared/src/index.ts`):** `COMMON_AREA_RESERVATION_KINDS`
  (tenant_reservation/private_rental/maintenance_closure/event), `_STATUSES`
  (pending/approved/rejected/cancelled), `LANDLORD_RESERVATION_KINDS`.
- **`services/commonAreas.ts`:** `lockArea` (advisory lock) + `findApprovedConflict`
  (overlap check vs approved holds) — no double-booking.
- **`services/notifications.ts` +3:** `notifyReservationRequested` (→landlord),
  `notifyReservationDecision` (→tenant), `notifyAmenityUnavailable` (resident fan-out
  via v_lease_active_tenants→lease→unit→property; excludes the booker).
- **`routes/commonAreas.ts`** at `/api/common-areas` (mounted in index.ts): landlord
  area CRUD; landlord create private-rental/closure/event (live + alert, conflict-checked
  under lock); decide pending requests; tenant `/mine` (reservable areas + upcoming holds),
  `/:id/request` (auto-approve or pending), `/my-reservations`, cancel.
- **Frontend:** landlord `pages/AmenitiesPage.tsx` (route `/amenities`, nav under
  Inspections); tenant `TenantAmenitiesPage` in `main.tsx` (nav "🎉 Amenities", route).
- **Tests:** `routes/commonAreas.test.ts` (9) green.
- **Deferred (non-blocking):** reservation-fee SETTLEMENT (fee captured/displayed, not
  charged — wire to lease-fee/payment rails later); open/close hours are advisory (no
  per-property timezone) — duration + lead-time ARE enforced.

## B. Service interruptions / utility-outage broadcasts — SHIPPED, green

Answered Nic's question ("does maintenance alert tenants for water/power shutoff with
expected back time?") — NO, it didn't. Maintenance `priority='emergency'` is INBOUND
only (tenant reports → operators paged). Built the OUTBOUND broadcast.

- **Migration `20260625130000_service_interruptions.sql`** (applied): `service_interruptions`
  (utility_type, unit_ids[] empty=whole property, is_emergency, starts_at,
  expected_restore_at, status, residents_notified_at, restore_notified_at).
- **Shared:** `SERVICE_INTERRUPTION_TYPES` (water/power/gas/heat_ac/elevator/internet/
  parking/other) + `_TYPE_LABELS` + `_STATUSES` (scheduled/active/resolved/cancelled).
- **`notifications.ts` +2:** `notifyServiceInterruption` (resident/unit-subset fan-out,
  **SMS on emergency**) + `notifyServiceRestored` (all-clear).
- **`routes/serviceInterruptions.ts`** at `/api/service-interruptions` (mounted): post→notify,
  list, resolve(+all-clear), cancel; tenant `/mine` live feed.
- **Frontend:** landlord **"Outages" tab** on MaintenancePage
  (`components/ServiceInterruptionsPanel.tsx` — post modal w/ utility type, emergency toggle,
  now-vs-scheduled, expected-back, whole-property-vs-unit-subset; resolve/all-clear/cancel);
  tenant **`ServiceOutageBanner`** on HomePage (red=emergency/amber=scheduled, 2-min poll).
- **Tests:** `routes/serviceInterruptions.test.ts` (8) green.
- **Deferred:** SMS auto-activates when Twilio is wired (stub present); no scheduled→active
  auto-flip cron (tenant feed shows scheduled+active regardless — non-blocking).
- **Nic scope decisions:** targeting = whole-property + optional unit subset; types = the
  common 8 set incl. Other.

## C. WALKTHROUGH_CHANGES.md pass — many items cleared

Audited the open/partial items vs code (several were stale). Counts at shutdown:
**85 [x] · 8 [~] · ~19 [ ]**.

Newly **built + verified** this session:
- **Landlord #24** inspection auto-form — NewInspectionPage auto-fills active lease + primary
  tenant from the unit's tenancy (overridable, hint). tsc/build green.
- **Landlord #16** subleases read-only — View modal (`<fieldset disabled>`) on non-pending rows.
- **Landlord #32** RESOLVED (Nic: leave visible). It's the rental-history report (GAM credit
  ledger, NOT Checkr — that's /background). Re-added to nav as **"Rental History"**.
- **Landlord #12** payment-health → tenant. New `GET /api/tenants/me/payment-health`; "Payment
  Health" card on tenant HomePage. 2 endpoint tests. Also satisfies **Tenant #5** at launch
  (true credit-score card deferred — score is gam_internal_only, /credit launch-hidden).
- **Marketing #1–4** — FULL public-site overhaul (`apps/marketing/src/index.html`): purged the
  rent guarantee, operational-reserve fronting, OTP float/$20 fee, fabricated testimonials, the
  "Stripe disputes handled by GAM (application loss)" line (contradicted S512), and the
  SLA/collection-agent legal disclaimer. Repositioned around real value (Stripe in/out, $2/unit,
  Eviction Mode, RV/extended-stay focus). Fixed free-vs-billed contradiction.
- **Operations #1** — admin-ops "No Flex" KPI now drills into the filtered tenant list.

**Reconciled to [x]** (already done, list was stale): Tenant #7 (FlexDeposit custody, S514),
Landlord #5 (David has renewal + notif-pref tools), Landlord #7 (onboarding $2-flat, no OTP).

**Resolved by decision (no code):** Landlord #14 (Tenant Onboarding tab IS the CSV import — keep),
Admin #6 (keep password-gated self-service 2FA disable; dead labels already hidden),
Admin&Ops #1 (two-tier split already exists: admin-ops vs admin portals).

**Deferred with reasons:** Operations #2 (needs admin-ops units endpoint), #3 (FlexSuite hidden
at launch).

## SHUTDOWN STATE (all green, uncommitted)

- 2 migrations applied this chat + schema.sql regen'd: `20260625120000_common_areas_and_reservations`,
  `20260625130000_service_interruptions`.
- New test files: `commonAreas.test.ts` (9), `serviceInterruptions.test.ts` (8); +2 in
  `tenants-profile-dashboard.test.ts`. Final check: **31/31 green** across the three suites.
- API tsc clean; landlord/tenant/admin-ops vite builds green; marketing is static HTML (no build).
- No half-finished edits.

## Files touched
- Shared: `packages/shared/src/index.ts`
- API: `db/migrations/20260625120000_*.sql`, `db/migrations/20260625130000_*.sql`,
  `services/commonAreas.ts` (new), `services/notifications.ts`, `routes/commonAreas.ts` (new),
  `routes/serviceInterruptions.ts` (new), `routes/tenants.ts`, `index.ts`,
  `routes/commonAreas.test.ts` (new), `routes/serviceInterruptions.test.ts` (new),
  `routes/tenants-profile-dashboard.test.ts`
- Landlord: `pages/AmenitiesPage.tsx` (new), `components/ServiceInterruptionsPanel.tsx` (new),
  `pages/MaintenancePage.tsx`, `pages/NewInspectionPage.tsx`, `pages/SubleasesPage.tsx`,
  `pages/NotificationPrefsPage.tsx`, `components/layout/Layout.tsx`, `main.tsx`
- Tenant: `main.tsx` (banner, amenities page, payment-health card, prefs, nav, routes)
- Admin-ops: `main.tsx`
- Marketing: `src/index.html`
- Docs: `WALKTHROUGH_CHANGES.md`

## What next session should target
Remaining open `WALKTHROUGH_CHANGES.md` items are genuine feature builds, one focused pass each:
- **Moderate:** Landlord #23 (remote-inspection ask-once — migration + agent state), POS #1
  (business margin/auto-pricing), POS #2 (charge-account name blend + drop property select),
  PM Company #3 (self-register, email-verify prod / auto dev), Listings #1 (application→Checkr),
  Platform #1 (centralize @gam/shared src alias), Tenant #6 (move-in inspection gate — sensitive).
- **Large (multi-pass):** Landlord #10 (Master Schedule overhaul), #11 (bookings waitlist),
  #29 (work-trade billing), Property-Intel #1 (data accuracy — marked "later").
- **Separate product (not GAM launch):** the 6 Fitness items.
- **Backend flag:** the marketing sales agent (Jordan, services/agents) prompt may still pitch
  OTP/guarantee — sweep it to match the de-guaranteed site copy.

## How to resume
- `~/gam-start.sh` boots everything. Logins/ports per CLAUDE.md.
- Re-run this session's suites: `cd apps/api && npx vitest run src/routes/commonAreas.test.ts
  src/routes/serviceInterruptions.test.ts src/routes/tenants-profile-dashboard.test.ts`
- New surfaces: landlord `/amenities` + Maintenance→Outages tab; tenant "🎉 Amenities" + home
  outage banner + Payment Health card; admin-ops No-Flex card drill-in; marketing site rewritten.
