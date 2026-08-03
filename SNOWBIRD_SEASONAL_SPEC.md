# Snowbird / Seasonal Tenancy — Design Spec (S576)

Status: DESIGN LOCKED (Nic, S576). Not yet built. Build in phases (bottom of doc).

## Problem

Extended-stay / RV parks have reliable recurring seasonal residents ("snowbirds")
— same person, same spot, roughly the same months every year (e.g. Oct–Apr).
They're easygoing and reliable, but the traditional flow is tedious for them and
for staff: full re-lease + re-screening every season, or a month-to-month with a
30-day-notice dance to end/restart. We want to hold their arrangement across the
off-season and bring them back with near-zero friction, while keeping the books
organized and the spot earning revenue while they're away.

Scope is GENERAL: applies to all snowbirds, whether or not they do work trade.
The pause lives on the LEASE; a work-trade agreement (if any) follows it.

## Core model

Three coupled pieces, most of it riding the EXISTING reservation engine:

### 1. Hibernating lease
- A seasonal lease can be flipped **off** (hibernate) when the resident leaves
  and **on** (resume) when they return — a landlord toggle (or driven by the
  season window, see §2).
- While hibernating: **no rent invoices generate**, the **deposit stays held**,
  the tenancy record persists (no termination), and **no 30-day notice / no
  re-lease / no re-screening**. Resume reactivates the SAME lease.
- Work trade follows: hibernate → work-trade agreement pauses; resume → active.
  The resident does nothing to come back except start logging hours again (or
  just pay, if they don't do work trade).
- NOT the retired auto-renew: this is a standing seasonal arrangement both sides
  agreed to up front, consciously paused/resumed — nobody is trapped.

### 2. Auto-recurring, spot-locked seasonal reservation
- The snowbird's season is just a **reservation** on their spot, **locked to the
  spot** (existing lock-to-spot feature), **auto-recurring** to roughly the same
  window each year (a nominal season window set at onboarding; matched forward
  each year in perpetuity).
- That reservation window is the ONLY time the spot is blocked for them. It
  couples to the lease: active during the window, dormant outside it.
- **Adjustable** — expand it and the surrounding schedule compresses; shrink it
  and other reservations grow into the freed space. Editable ahead of time by
  the landlord AND by the snowbird themselves (§4).

### 3. Off-season = fully bookable, bounded only by the next season window
- When the lease is hibernating, the spot is **fully open** to others — a
  4-month summer worker, a run of two-week stays, whatever earns revenue.
- The only constraint is the standard one the reservation engine already
  enforces: nothing may overlap the snowbird's blocked season window. Bookings
  fill the void and yield to it.

## WHAT ALREADY EXISTS (verified S576 — the reservation side is mostly built)

Recon + a live move test confirmed the reservation-side machinery this feature
needs is already in place:

- **Morning-of site reveal** — `scheduler.revealTodaysSites` (W-20) emails the
  guest their spot only on check-in day; `emailBookingSiteAssignment`
  (category `booking_site_reveal`). **S576: changed to fire at 6:30am property-
  local** (was check_in_time − 1h) so guests get a couple hours' notice. The
  `unit_bookings.site_reveal_sent_at` stamp is THE movement fence.
- **Auto self-compression** — `scheduleCompression.compressAllSchedules`
  (nightly 3:30am) best-fit re-packs movable future bookings, honoring
  site-layout/amp compatibility. A booking is movable only if confirmed (or
  tentative w/ live hold), NOT revealed, NOT checked-in, NOT lease-drafted.
- **Extension-priority relocation** — `scheduleCompression.relocateBlockingBookings`
  ALREADY implements the snowbird priority/relocation rule almost exactly: called
  from `PATCH /units/:id/bookings/:bookingId` on extend, it relocates blocking
  bookings to a compatible open spot and REFUSES when the blocker is checked-in
  ("already checked in"), revealed ("already told their site"), lease-bound, or
  `locked_to_unit`, and when there's "No compatible open site" (park full). Live
  test S576: extended an anchor over a movable guest → guest re-sited RV 02 → RV
  01 automatically. Tested in `scheduleCompression.test.ts` (11 pass).
- **Spot lock** — `unit_bookings.locked_to_unit` (S547) already pins a stay to
  its exact site (the "snowbird lock"); relocation respects it.

So the NET-NEW work is mostly the LEASE/tenancy + account side, not the calendar
engine: hibernating lease + work-trade lockstep, auto-recurring seasonal
reservation generation (+ coupling to the lease window), tenant self-service
editing, and a per-account "priority snowbird" marker (today it's per-booking
`locked_to_unit`). Phase 3's relocation is essentially done — mostly wiring the
priority marker to it.

## Reservation spot-fluidity (the key existing behavior this rides on)

Regular reservations are **spot-fluid until check-in morning**: the guest is NOT
told a specific spot ahead of time; the system emails their spot number the
morning of check-in, on purpose, so staff can rearrange the schedule. Internally
a reservation shows on a spot on the Master Schedule, but for un-locked,
not-yet-checked-in reservations that assignment can be shuffled freely among
compatible spots with **zero guest-facing impact**.

- Snowbirds are the exception and that's their perk: **locked spot, known ahead
  of time.**
- So "relocating" a bumped guest is invisible — no email, no disruption; they
  still just get their assigned spot the morning they arrive.

## Priority accounts + the relocation rule

- Landlords mark a snowbird account as a **priority account**.
- A priority snowbird can **extend or shorten their reservation at will**
  (self-service or landlord-driven).
- **An extension into a conflicting reservation succeeds only if BOTH:**
  1. that guest is NOT already **checked-in-and-paid** (physically parked
     there), AND
  2. there is an **open, compatible spot** to relocate that guest to (dates free
     + meets their site/hookup/amp requirements — reuse existing RV-requirement
     matching).
- **If either fails** — someone parked-and-paid is in the way, OR the park is at
  capacity with nowhere to shuffle — the snowbird **loses priority for that
  overlapping slice** (blocked). This protects deposit-committed guests: nobody
  is ever cancelled, only moved, and only when a move is possible.
- **When relocation is possible, the system moves the conflicting guest
  AUTOMATICALLY** — atomically (shift the guest to the open compatible spot +
  extend the snowbird in one step; no transient double-booking). Because regular
  guests have no committed spot until check-in morning, **no guest notification**
  is sent. A quiet **landlord-side audit log** records the move (NOT a to-do).
- Net effect: the snowbird wins in the common case; the only pinch is a
  last-minute front-end extension when the park is genuinely full. Back-end
  extensions almost never pinch (the next guest can't be checked in while the
  snowbird is still there); shortening always just frees space.

## Tenant self-service

- Once a snowbird has a tenant portal, they can log in and **edit their own
  seasonal reservation** ("only coming half the year," "staying an extra month")
  instead of calling the office.
- Self-edits apply the same priority/relocation rule automatically. No landlord
  approval needed — at-will — with the paid-and-present + capacity protections
  baked into the rule, and any silent auto-relocations logged for the landlord.

## Guest-friction layer: downgrade / auto-upgrade offers (S576)

The reshuffle stays invisible EXCEPT when it can't land a guest in their
preferred TYPE (they wanted 50-amp/pull-through, only 30-amp/back-in is open —
from a priority push, a capacity crunch, or a real spot outage). That's the only
guest-facing friction; handle it gracefully instead of hard-refusing (today
`relocateBlockingBookings` dead-ends at "No compatible open site").

- **Detect early, notify late.** When a booking can't be placed in a compatible
  spot, flag it + identify the best available alternative — but send NO guest
  contact until the offer window. Default **3 days** before check-in, landlord-
  adjustable **2–5 days**. Too early → they cancel + rebook elsewhere (lost
  revenue) or ask why it isn't fixed; too late → already traveling.
- **Neutral framing.** Guests never knew a specific spot (spot-fluid until
  reveal), only a TYPE — so the offer is about type: "your pull-through/50-amp
  site is unavailable (maintenance); we can offer a back-in/30-amp — does that
  work?"
- **Re-check at the window.** If a compatible spot freed up meanwhile, cancel the
  offer silently and keep them on their preferred type.
- **Money: guest pays the LOWER of {chosen-type rate, actual-spot rate}.** A
  forced move NEVER costs more than what they chose: bumped to a cheaper spot →
  pay the cheaper rate (auto-refund difference); forced onto a pricier spot
  because their choice was full → pay their ORIGINAL (cheaper) rate. Reads off
  the per-spot rates the landlord already set — no extra onboarding question.
- **Standing auto-upgrade claim (BOTH directions).** A displaced guest holds a
  priority claim on their PREFERRED type. When a compatible spot frees
  (cancellation / early departure), they're upgraded back AUTOMATICALLY — no
  re-asking — up to check-in morning (pleasant surprise at reveal).
- **Structural protection (not just polling).** The displaced guest's claim
  counts against that TYPE's availability, so a NEW booking cannot consume the
  last compatible spot owed to them — they literally can't book it. Because
  nothing is spot-committed until reveal, actual re-seating just needs a light
  sweep (3–4×/day) to execute; the protection is the capacity-level claim, not
  the poll frequency. (Nic: "I just wanna be sure we take care of guests.")
- **Decline / no-response = the deposit does the work.** With a deposit paid,
  guests won't walk from their money, so declines are rare + self-resolving
  (forfeit the deposit, spot frees for the priority claimant). Hold the spot; if
  deposit-only and they no-show, cancel after the first day or two; if paid in
  full, it's theirs the whole stay regardless.

## Reservation deposits + payment methods (S576)

- **Booking deposit (distinct from a lease security deposit)** — holds the spot
  and makes the downgrade/decline economics work. Push it as the norm. System-
  enforced: **default 10%, landlord-set 5%–20% in 5-point steps** (5/10/15/20 —
  no arbitrary %). Always some skin in the game.
- **Payment method split:** short-term / transient guests → **CARD** (instant;
  microdeposits couldn't clear inside a few-days booking horizon anyway).
  Long-term / recurring tenants + snowbirds → **ACH**, set up once, saves the
  card fee over many months. Long-term old-fashioned (cash/check/MO) payments
  keep the $10 invoicing fee (pushes ACH); **short-term on-site cash/check = NO
  fee** (not worth metering).

## ACH across hibernation — billing correctness (S576, VERIFIED invoice-driven)

Rent is INVOICE-DRIVEN, not a standing Stripe subscription: `invoiceGeneration`
bills only `status='active'` leases and creates the `pending` charges that get
pulled. So:
- **Hibernate stops INVOICES, never the bank MANDATE.** No invoice → nothing
  pulled → snowbird never wrongly charged in the off-season. The ACH
  authorization sits idle; NEVER cancelled/re-verified (no re-doing microdeposits
  each season). Resume (lease → active) → invoicing + pulls resume.
- **Arrears-utility tail:** at season-end the departure's final meter read →
  final utility bill (existing move-out/turnover settlement) → ACH pulls it
  BEFORE full hibernation, so nothing bills into the dead season.
- **Resume sequencing (natural, no special code):** cycle 1 = rent; cycle 2 =
  prior-month utilities (arrears) + rent; … deposit held throughout.
- **Build rule:** hibernate = (1) settle final utility like a move-out, (2) stop
  invoice generation for the lease, (3) leave the ACH mandate untouched. Resume =
  flip active; invoicing restarts. NOTE: `invoiceGeneration` keys on
  `status='active'` — the hibernation gate must make the lease not bill (either a
  distinct state or a flag gated into the billing consumers: invoiceGeneration +
  platform-fee accrual + any autopay).

## Utility baseline on resume — NOTHING TO BUILD

The existing departure / turnover read workflow already guarantees a fresh
baseline: whoever occupied the spot in the off-season does a checkout read, and
if the spot sat empty the snowbird's own prior departure read is the baseline.
No extra resume-time read flag is needed. (See utility turnover-reads system.)

## Data model changes (to detail at build time)

- **Lease:** a hibernation state — lean toward a boolean/flag (e.g.
  `is_hibernating` / seasonal state) that invoice generation + billing consumers
  skip, rather than a new `status` enum value (avoids touching every status
  consumer). Deposit retention across hibernation already matches renewal-handoff
  posture. Couple resume/pause to the work-trade agreement status.
- **Seasonal config:** per seasonal tenancy — nominal season window (month/day
  start+end), spot lock, priority flag, recurrence. Fields on the lease or a
  `seasonal_tenancies` companion row.
- **Reservations:** auto-generate the recurring seasonal reservation each year;
  a `priority` level (from the account); reuse lock-to-spot; the relocation
  reshuffle in the booking/conflict engine + a relocation audit log.
- **Account:** landlord-set "snowbird / priority" marker on the tenant/lease.
- **Work trade:** already has active/paused — couple to lease hibernation.

## Phased build order

1. **Hibernating lease + work-trade lockstep** — flip off/on; invoice-gen skips
   hibernating (final-utility-settled first); deposit held; work-trade
   pauses/resumes with it; ACH mandate untouched.
2. **Auto-recurring, spot-locked seasonal reservation** — season config +
   yearly generation, coupled to the lease window.
3. **Priority accounts + auto-relocation** — priority marker wired to the
   EXISTING `relocateBlockingBookings`; audit log. (Engine mostly built.)
4. **Guest-friction layer** — downgrade/auto-upgrade offer flow, min-rate rule,
   structural type-claim protection, offer-window timing.
5. **Reservation deposits + payment split** — booking deposit (10% def, 5–20%),
   card-transient / ACH-recurring.
6. **Tenant self-service reservation editing** — portal surface, same rule.

## Decisions locked (S576)
- Scope general (all snowbirds, not just work-trade). ✔
- Off-season spot fully bookable; blocked only by the next season window. ✔
- Priority relocation, never cancellation; only if a compatible spot is free. ✔
- Paid-AND-present guests can never be bumped. ✔
- Auto-move on relocation; no guest email (spot-fluid until check-in AM);
  landlord audit log only. ✔
- Tenant self-service at-will; rule enforced automatically, no approval. ✔
- Resume meter read: nothing to build (existing turnover-read workflow). ✔
- Downgrade offer: detect early, notify at 3d default (2–5 landlord-set),
  neutral "maintenance" framing, re-check at window. ✔
- Downgrade money: guest pays LOWER of {chosen-type rate, actual-spot rate} —
  a forced move never costs more. ✔
- Auto-upgrade back to preferred type, both directions, automatic (no re-ask),
  up to check-in morning; structural type-capacity claim so new bookings can't
  steal it; light sweep 3–4×/day executes. ✔
- Decline/no-response handled by the deposit (forfeit); hold spot, cancel after
  1–2 day no-show if deposit-only, full stay if paid in full. ✔
- Booking deposit: 10% default, 5–20% in 5-point steps, system-enforced. ✔
- Payments: card for transient, ACH for recurring/long-term; short-term on-site
  cash/check = no fee; $10 stays on long-term old-fashioned. ✔
- ACH across hibernation: invoice-driven (VERIFIED), so hibernate gates invoices
  not the mandate; final utility settles at departure; resume restarts. ✔
