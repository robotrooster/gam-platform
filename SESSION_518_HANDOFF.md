# SESSION 518 HANDOFF

Theme: **Master Schedule (#10) overhaul + reservation flow rebuild**, almost
entirely LIVE-ITERATED with Nic on the running app (`bash dev.sh`, landlord
:3001 `/schedule`, demo login `james@demo.dev` / `landlord1234` — the account
with the 9 demo units; `realestaterhoades@gmail.com` has ZERO units). All work
uncommitted (Nic decides commits). **3 migrations applied this session, all
2026-06-26/27**, schema.sql regen'd each. Builds green; suites green.

> S517 handoff covered work-trade #29, booking sites #11, the polish tail, and
> left #10 "needs Nic." THIS file covers the #10 deep-dive that followed.

---

## Shipped this session (#10 Master Schedule)

### Objective bug fixes
- Drag-to-move landed bookings a day EARLY (`addDays(targetDate,-1)`) → now `targetDate`.
- Then landed a SITE to the RIGHT — drop used the cell the drop event fired on; now uses
  `dragOverRef.current` (the cell the HIGHLIGHT showed). Lands where you see the preview.
- Config-modal Monthly Rate was blank (master query omitted `monthly_rate`) → added.
- Dragging a booking WITHIN its own unit tripped "unit doesn't allow bookings" → that gate
  (and the empty-`lease_types_allowed`=`[].includes` bug) now only fires on CROSS-unit moves.

### Layout
- Reservations render as ONE continuous bar (was beaded per-cell squares — round only at true ends).
- `table-layout:fixed` + page is full-bleed for `/schedule` only (`.page-content-wide`, route-scoped in
  Layout) so it uses the whole monitor (the 1400px cap mis-fit a wide display). Fixed ~30px columns
  (a measured fit mis-read full display width → ~15 days).
- Wide fixed date range (today−31 → +151), scroll both ways, auto-scroll to today, no window-shifter nav.
- Reservation SEARCH (guest/unit) → jumps the timeline. History VIEW (booking change log).

### Change-history log
- `unit_booking_events` (migration `20260626180000`) + `services/bookingEvents.ts` (records create +
  diffs edits, "N days added/removed") + `GET /units/schedule/history` + the History tab.

### New-Reservation flow — REBUILT to dates-first (Nic's repeated direction)
- dates → guest contact (separate **First/Last** + email + phone, ALL required) → only **bookable**
  units free for those dates populate, each showing the stay total; click a unit to create. No type
  picker (tier implied by length), no separate Create button.
- All units full → **Add to waitlist** (property-wide entry, unit_id NULL, migration `20260627121000`);
  `promoteNextWaitlister` promotes property-wide waiters + pins them to the freed unit. Email required.

### Pricing (`computeStayPrice` in `@gam/shared`)
- Tier by length: <7 nightly, 7–29 weekly, 30+ monthly; PRORATED (32 nights = monthly + 2/30·monthly);
  short-term lodging tax under 30 nights, tax-exempt 30+.
- Rates are PROPERTY-level (migration `20260627120000`: `properties.nightly_rate/weekly_rate/monthly_rate/
  short_term_tax_rate`), landlord-set on the **Booking Sites page** (booking-config GET/PATCH extended).
- **AUTHORITATIVE on the backend**: `POST /units/:id/bookings` computes `total_amount` server-side from
  property rates (overrides client; falls back to client total only if no rates). This fixed the "$0 / stale
  cache" totals. Verified: 3 nights → $336 (300 + 12% tax), 30 nights → $2000 (no tax). james's properties
  seeded with nightly $100 / weekly $600 / monthly $2000 / 12% tax; units 201/202/203 made `is_bookable`
  (101–106 stay non-bookable → excluded, demonstrating the gate).

### Reservation detail panel (click a bar)
- Guest/unit/dates/nights/email/phone/total/status/notes + **Cancel reservation** + **Copy stay link**.
- QR retired from this flow (Nic: doesn't justify itself for remote bookings; link auto-emails on create).
  "Copy stay link" hits the guest-access endpoint + copies the URL (prompt fallback when the browser blocks
  `navigator.clipboard` on http — that was the "could not generate" error). Leases render read-only.

---

## SHUTDOWN STATE
- Migrations applied (this session): `20260626180000_unit_booking_events`, `20260627120000_property_stay_rates`,
  `20260627121000_waitlist_property_wide`. schema.sql regen'd. (S517's `20260626160000/170000` already handed off.)
- API tsc + shared build + landlord/customer builds green. Booking/schedule suites green (units 14, bookings 8,
  webhooks 22, leaseLifecycle 23, propertyBookingFlow 10, propertyBookingAdmin 9, publicPropertyBooking 12,
  bookingEvents 6, workTradeCredit 13, reports 34).
- Dev stack running for Nic's testing: `bash dev.sh` (API :4000 + 13 portals; Postgres auto-up). Stop: `bash kill-all.sh`.
- Nic's two manual test reservations remain on the calendar (one $2266 correct, one $0 from the pre-fix
  cache bug — cancel via the detail panel).

## What next session should target
1. **Decide the single rate source.** PUBLIC booking site (`publicPropertyBooking`) still reads UNIT rates
   (`units.nightly_rate/weekly_rate`); the Master Schedule + manual `POST /units/:id/bookings` read PROPERTY
   rates. Unify so a property's rates drive both (lean: point the public site at property rates too, deprecate
   the unit rate fields in the ⚙ Configure modal).
2. Master Schedule candidate follow-ups: drag-to-EXTEND a stay by its edge (today drag only MOVES); clearer
   lease-vs-booking visuals; search matching email/dates; pull the QR popup from the OTHER "Guest link"
   button (`SchedulePage.tsx:~705`) if it's unwanted everywhere.
3. Rest of the walkthrough is otherwise vendor/infra-gated (Checkr, Twilio, Stripe live keys, wildcard
   subdomain DNS, host/deploy) per DEFERRED.md + the #31/#11 entries.

## How to resume
- `~/gam-start.sh` (models + Postgres + apps) or `bash dev.sh` (API + portals; PG auto-up). Master Schedule:
  landlord `/schedule` (`apps/landlord/src/pages/SchedulePage.tsx`), `apps/api/src/routes/units.ts`
  (`schedule/master` + `schedule/history` + booking POST/PATCH), `services/bookingEvents.ts`,
  `services/propertyBooking.ts` (waitlist), `routes/propertyBookingAdmin.ts` (rate config + property waitlist),
  `packages/shared` `computeStayPrice`. Rate config UI: `apps/landlord/src/pages/BookingSitesPage.tsx`.
- Re-run: `cd apps/api && npx vitest run src/routes/units.test.ts src/routes/propertyBookingFlow.test.ts
  src/routes/propertyBookingAdmin.test.ts src/services/bookingEvents.test.ts`
