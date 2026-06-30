# SESSION 519 HANDOFF

Theme: **Walkthrough #10 follow-through — booking pricing pulls from the UNIT,
edit-reservation, RV site layout (back-in/pull-through), Master Schedule polish,
and public-site pricing unification.** Launch-day session. All driven by Nic's
direction ("pull from the unit"; "auto-tiered pricing, guest doesn't select,
taxes <30 days set at property level by state/city"). All work uncommitted (Nic
decides commits). **1 migration applied** (`20260627130000`), schema.sql regen'd.
Builds + suites green.

> S518 left #10 as the live-iterated Master Schedule rebuild and flagged "unify
> the rate source" + edit/visual follow-ups as next. THIS session closed those.

---

## Shipped

### 1 · Rate source = the UNIT (property = default)
- `POST /units/:id/bookings` prices from `unit.{nightly,weekly,monthly}` falling back to the property rate
  per-rate, via `computeStayPrice` (+ property `short_term_tax_rate`). Was property-only.
- `PATCH /units/:id/bookings/:bookingId` **bug fix**: it recomputed `nights` on a date/unit change but never
  the total → stale price. Now reprices on any date/unit change (same unit-then-property rule). Also now
  accepts guest name/email/phone.
- SchedulePage staff preview (`stayPriceForUnit`, `createResvMut`) aligned unit-first.

### 2 · Edit existing reservations (was impossible — only Cancel existed)
- Detail panel gained an **Edit** mode: unit, dates, guest contact, notes, live re-price preview, Save/Cancel.
  Backend half is the PATCH guest-field + reprice above.

### 3 · RV site requirements — site layout + electrical service (warn, never block — Nic's call)
- **Site layout (back-in / pull-through):** migration `20260627130000_rv_site_layout.sql`:
  `units.rv_site_layout` + `unit_bookings.required_site_layout` (CHECK = shared `RV_SITE_LAYOUTS` =
  none/back_in/pull_through; default 'none', no backfill). Shared `RV_SITE_LAYOUTS`/`RV_SITE_LAYOUT_LABEL`/
  `isSiteLayoutMismatch()`.
- **Electrical service (30 / 50 / both amp):** migration `20260627140000_rv_amp_service.sql`:
  `units.rv_amp_service` + `unit_bookings.required_amp_service` (CHECK = shared `RV_AMP_SERVICES` =
  none/30/50/both). A unit set to 'both' satisfies a 30- OR 50-amp reservation; a 50-amp reservation onto a
  30-amp-only site (or vice versa) warns. Shared `RV_AMP_SERVICES`/`RV_AMP_SERVICE_LABEL`/`isAmpServiceMismatch()`.
- Backend: `/units/:id/type` config persists both; POST/PATCH bookings persist `requiredSiteLayout` +
  `requiredAmpService` (validated); master-schedule SELECT returns both unit fields.
- Frontend: unit-config modal exposes both (rv_spot only); new-reservation flow has optional layout + amp
  selectors that flag mismatched units; drag-move + edit-panel warn on mismatch but proceed. Layout + amp
  checks unified into one `rvMismatchReasons` guardrail (single combined warning/confirm).

### 4 · Master Schedule drag — rewritten, now working flawlessly (Nic-confirmed)
- **Native HTML5 drag-and-drop** (a pointer-events rewrite was tried + reverted — it crashed on the same bug
  below; native DnD is the mechanism). Handlers `onDragStart`/`onDragOver`/`onDrop`/`onDragEnd` + `commitDrag`,
  with `dragInfo` + `dragTargetRef` refs and a `preview` state driving the highlight.
- **ROOT CAUSE of every drag bug (3+ failed attempts): dates are `date` columns that pg returns as JS Date →
  the API serializes them to full ISO timestamps** (`check_in: "2026-07-21T07:00:00.000Z"`). Two consequences,
  both now fixed with a `dayOnly(s) = String(s).slice(0,10)` helper applied on BOTH sides of every comparison:
  1. `addDays`/`daysBetween` appended `T12:00:00` to a timestamp → **Invalid Date** thrown in onDragOver →
     drag silently dead (this was "can't drag at all" / "drop does nothing, snaps back").
  2. Bar rendering compared day strings to timestamps (`"2026-07-21" >= "2026-07-21T07:.."` is FALSE — prefix
     sorts before) → **every bar rendered shifted one day right** while the day-only preview was correct →
     the persistent "off by one". Fixed in `getBookingForDate`, `isStart`/`isEnd`, availableUnits + commitDrag
     conflict checks, and the drag math.
- **Grab offset**: onDragStart records the grabbed cell; move keeps that day under the cursor
  (`checkIn = hoveredCell − grabOffset`). Preview resolves in onDragOver (amber on RV mismatch); the dragged
  bar stays mounted and tints gold over the target range (replacing it mid-drag cancels native DnD).
- **Resize**: ONE draggable bar; mode chosen from grab position — outer ~10px of a stay's start/end cell
  (via `e.nativeEvent.offsetX`) resizes that edge, else move. Nested draggable grips were unreliable (browser
  chose the parent) → grips are now visual-only (`pointerEvents:'none'`). Reprices via PATCH.
- **Lesson for next session**: the dev server log (`/tmp/gam-landlord.log`) surfaces client runtime errors —
  that's how the Invalid Date crash was finally found. Drag itself isn't agent-verifiable; Nic confirms live.
- **Lease vs reservation visual**: lease bars carry a 🔒 prefix; legend updated.
- **Search** now matches guest email + phone + dates (was name/unit only).

### 5 · Public booking site pricing unified (Nic spec)
- `services/propertyBooking.ts` (quoteStay/bookStay) + `routes/publicPropertyBooking.ts` (availability) now
  price via `computeStayPrice`: auto-tier by length, unit-rate→property-default, short-term tax (<30 nights)
  from property `short_term_tax_rate` (landlord-set per city/state — not an auto jurisdiction lookup). The
  guest no longer picks nightly/weekly. `lease_type` stamped from the computed tier. `computeStayTotal` kept
  exported (legacy/unused) so the route re-export + tests don't break.
- Customer app `PropertyBookingPage`: dropped the rate picker; shows base + tax breakdown; stopped sending
  `stayType`.

---

## Decisions (Nic, 2026-06-27)
- Canonical rate = the UNIT; property rate is the default. RV spots/storage share a price by default; per-unit
  overrides (incl. pull-through vs back-in) honored.
- Site-type mismatch = **warn and allow**, never hard-block.
- Site-type for launch = ship edit today, site-type as immediate fast-follow (done same session).
- Public pricing = **auto-tiered, guest doesn't select**; tax on stays <30 days; tax rate is property-level,
  landlord-set by state/city.

## SHUTDOWN STATE
- Migrations applied: `20260627130000_rv_site_layout`, `20260627140000_rv_amp_service`. schema.sql regen'd.
- tsc + build green: shared, api, landlord, customer. Tests: 104 green across units(14)/bookings(8)/
  propertyBookingFlow(10)/propertyBookingAdmin(9)/publicPropertyBooking(12)/webhooks(22)/bookingEvents(6)/
  leaseLifecycle(23). (email_send_log FK + "no allocation rule" log lines are pre-existing best-effort /
  negative-path test noise — suites pass.)
- Demo seeded on `james@demo.dev`: 201 = rv_spot/pull_through/both-amp, 202 = rv_spot/back_in/30-amp, 203 = apartment/none.
- Dev stack was running for Nic's review (`bash dev.sh`; landlord :3001 `/schedule`). Changes are HMR/respawn-live.

## Files touched
- `packages/shared/src/index.ts` (RV_SITE_LAYOUTS + helper)
- `apps/api/src/routes/units.ts` (booking POST/PATCH pricing + guest fields + layout; /type layout; master SELECT)
- `apps/api/src/routes/publicPropertyBooking.ts` (computeStayPrice availability + property rate/tax cols)
- `apps/api/src/services/propertyBooking.ts` (quoteStay/bookStay auto-tier + tax + unit/property fallback)
- `apps/api/src/db/migrations/20260627130000_rv_site_layout.sql` (new)
- `apps/landlord/src/pages/SchedulePage.tsx` (edit panel, layout, drag-extend, visuals, search)
- `apps/customer/src/pages/PropertyBookingPage.tsx` (drop picker, tax breakdown)
- `WALKTHROUGH_CHANGES.md` (#10 updated)

## What next session should target
1. The public booking site, FlexSuite, Checkr, SMS, etc. remain **vendor/infra-gated** (Checkr Monday,
   Stripe live keys, Twilio, wildcard subdomain DNS/TLS, deploy) — see DEFERRED.md. No more code to land there.
2. Optional follow-ups: pull the QR popup from the other "Guest link" button if unwanted; cancel the stale
   $0 test reservation (or edit/reprice via the new detail-panel Edit).
3. If `computeStayTotal` (now dead) bothers you, delete it + its route re-export + any test import in a
   dedicated cleanup pass.

## How to resume
- `~/gam-start.sh` or `bash dev.sh`. Master Schedule: landlord `/schedule`
  (`apps/landlord/src/pages/SchedulePage.tsx`), `apps/api/src/routes/units.ts`, `services/propertyBooking.ts`,
  `routes/publicPropertyBooking.ts`, `packages/shared` `computeStayPrice`/`RV_SITE_LAYOUTS`.
- Re-run: `cd apps/api && npx vitest run src/routes/units.test.ts src/routes/publicPropertyBooking.test.ts
  src/routes/propertyBookingFlow.test.ts`
