# SESSION 517 HANDOFF

Theme: **Continued the `WALKTHROUGH_CHANGES.md` sweep** after S516. Shipped the
last big buildable launch items + cleared the polish tail. All work uncommitted
(Nic decides commits). **3 migrations applied this session, all 2026-06-26**,
schema.sql regen'd each time. Everything builds green; new/changed suites pass.

> Scope this session was strictly `WALKTHROUGH_CHANGES.md` + `DEFERRED.md` work
> (Nic). Several walkthrough entries were also CORRECTED for accuracy (recon
> contradicted stale notes) — see below.

---

## Shipped this session (all green, with tests)

### Landlord #29 — work-trade billing rebuilt to the locked percent model
Recon contradiction: a full `work_trade_*` subsystem already existed (dollar
hourly-rate model, never wired to billing). Per Nic ("build what i said, get rid
of the useless stuff") it was converted to the locked **percent-of-invoice** model:
- Migration `20260626160000_work_trade_percent_model.sql`: `properties.work_trade
  _hours_target` (default 80); stripped agreements to enrollment-only (dropped
  trade_type/hourly_rate/weekly_hours/market_rent/cash_rent/trade_credit_max/
  ytd_value/flag_1099/tax_year); dropped `work_trade_periods` + `work_trade_logs
  .credit_value`; added `invoices.work_trade_credit_amount/_hours/_agreement_id`.
- `services/workTradeCredit.ts` (each approved hr = 1/target of the TOTAL invoice,
  capped 100%, prior-month window); wired into `jobs/invoiceGeneration.ts` (net
  total, $0-settled fully-covered rows, sublease-guarded). `routes/workTrade.ts`
  rebuilt (enrollment create, drop /reconcile, property-target GET/PATCH).
  Frontend tenant + landlord WorkTradePage rewritten.
- FIX-IT-RIGHT: `reports.ts` 1099/tax-summary now derive value from
  `invoices.work_trade_credit_amount` (dropped tax_year/ytd_value would have 500'd).
- Tests: workTradeCredit 13, workTrade route 26, reports 34, tenants-misc 5,
  leaseLifecycle 23 (non-work-trade path unchanged) — green.

### #11 — subdomained per-property booking sites + waitlist (5 stages, DONE)
Short-term nightly/weekly public booking, deposit-at-booking via Stripe, 1-hr
waitlist claim. Mirrors the S507 business booking pattern; subdomain is
frontend/DNS only (slug-based API).
- Migration `20260626170000`: property booking config (slug/enable/intro/deposit%),
  `unit_bookings` deposit fields, `unit_booking_waitlists` table. Shared enums.
- `routes/publicPropertyBooking.ts` (profile/availability/book/waitlist/claim),
  `services/propertyBooking.ts` (bookStay advisory-locked + Stripe deposit Checkout
  to landlord Connect; waitlist join/promote/claim; sweep), `routes/property
  BookingAdmin.ts` (landlord config + waitlist view), `webhooks.ts` booking_deposit
  confirm, units.ts cancel→promote, scheduler minute-ly sweep, stripeConnect
  `createBookingDepositCheckoutSession`.
- Frontends: customer `PropertyBookingPage` + `ClaimPage` + `/booked` + slug-resolve
  (`lib/slug.ts`); landlord `BookingSitesPage` + nav.
- Tests: publicPropertyBooking 12, propertyBookingFlow 9, propertyBookingAdmin 6 —
  green; units/bookings/webhooks no regression.
- LAUNCH-INFRA TAIL: wildcard `*.<gam-domain>` DNS+TLS; live Stripe keys to exercise
  the hosted deposit Checkout (webhook confirm unit-proven via simulated events).

### #10 — Master Schedule (FIRST PASS; pending Nic's continued review)
- Objective bugs fixed: drag-to-move landed 1 day early (`addDays(targetDate,-1)` →
  `targetDate`); config modal Monthly Rate blank (added `u.monthly_rate` to the
  master query); stale ack-badge comment.
- Layout (Nic spec): wide fixed range (today−31 → today+151), scroll both ways, no
  window-shifter "search" nav, auto-scroll to today on load. Day columns FIXED ~30px
  (a measured fit mis-read the full display width → only ~15 days; now ~a month+).
- Reservation SEARCH bar (guest/tenant/unit) → jump-to-timeline.
- Change-history log: migration `20260626180000` `unit_booking_events`;
  `services/bookingEvents.ts` records create + diffs edits ("N days added/removed");
  `GET /units/schedule/history`; new "History" view. 6 event tests green.

### Polish tail (all green)
- **Service Interruptions auto-flip** — `services/serviceInterruptions.ts` + 5-min
  cron flips scheduled→active at start time (3 tests). No auto-resolve (false
  all-clear risk).
- **Customer Portal invoice-paid return** — added `/invoice-paid` route +
  `InvoicePaidPage` + token in the success URL (paid customers were bounced to the
  landing page).
- **#39 Start-walkthrough UI** (Nic spec) — "Start guided walkthrough" button →
  manual New Inspection, with an "Automate with assistant" prompt; gave `ChatWidget`
  an `openAssistant(prefill)` open+prefill hook (prefills, never auto-sends).
- **Listings apply-surface dedupe** — removed a dead register/accept-invite modal
  (unreachable: `applying` was only ever set null); the single `/background-check`
  screening path remains.

## Walkthrough accuracy corrections (recon contradicted stale notes — no code)
- **#31 + Listings #1 (prospect screening)** — the "no public bg-check submission
  flow" claim was WRONG. `BackgroundCheckPage` already loads unauth + creates the
  prospect inline via register-prospect; Checkr fully coded (creds-gated); pool feed
  auto for speculative / on-deny for targeted. Both Flow A/B function today; only
  Checkr live creds remain.
- **#11 booking model** — recorded Nic's direction (per-property GAM-subdomained
  opt-in sites).
- **Property Intelligence** — marked NOT a launch feature (Nic).

---

## SHUTDOWN STATE
- 3 migrations applied this session (all 2026-06-26): work_trade_percent_model,
  property_public_booking_and_waitlist, unit_booking_events. schema.sql regen'd.
- API tsc clean; shared built; landlord/tenant/customer/listings + touched builds green.
- New test coverage green: workTradeCredit (13), workTrade (26), reports (34),
  tenants-misc (5), publicPropertyBooking (12), propertyBookingFlow (9),
  propertyBookingAdmin (6), serviceInterruptions (3), bookingEvents (6); units (14),
  bookings (8), webhooks (22), leaseLifecycle (23) no regression.
- No half-finished edits.
- Dev stack was started for Nic's review: `bash dev.sh` (API :4000 + 13 portals;
  Postgres already up). Models NOT started (not needed for the schedule). To stop:
  `bash kill-all.sh`.

## What next session should target
1. **#10 Master Schedule — continue the overhaul (Nic reviewing live).** Locked
   next item: **New-Reservation flow is backwards** — it asks for a UNIT first; it
   must be **DATES first → toggle showing only units AVAILABLE for those dates**.
   Rework the New Reservation modal / unit picker around date-first selection. Other
   candidates: drag-to-extend a stay by its edge; clearer lease-vs-booking visuals;
   search matching email/dates.
2. Remaining walkthrough is otherwise vendor/infra-gated: Checkr live creds (Mon),
   Twilio (outage SMS), Stripe live keys, wildcard subdomain DNS+TLS, Resend domain,
   Plaid, host/deploy/backups (DEFERRED.md tail).

## How to resume
- `~/gam-start.sh` boots everything (models + Postgres + apps); or `bash dev.sh`
  for just API + portals (Postgres auto-up). Logins/ports per CLAUDE.md.
- Master Schedule lives at landlord `/schedule` (`apps/landlord/src/pages/SchedulePage.tsx`)
  + `GET /api/units/schedule/master` + `/schedule/history` (`apps/api/src/routes/units.ts`).
- Re-run this session's suites: `cd apps/api && npx vitest run
  src/services/workTradeCredit.test.ts src/routes/workTrade.test.ts
  src/routes/publicPropertyBooking.test.ts src/routes/propertyBookingFlow.test.ts
  src/routes/propertyBookingAdmin.test.ts src/services/bookingEvents.test.ts
  src/services/serviceInterruptions.test.ts src/routes/reports.test.ts`
