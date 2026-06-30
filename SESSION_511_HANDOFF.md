# SESSION 511 HANDOFF

## Resume addendum (after the first save — verify pass + more Business + into Landlord)
After the first checkpoint we reopened everything (`~/gam-start.sh`) and continued. Shipped since:
- **Verify pass on prior work** — owner BookableServices cadence/"Repeats on" dropdowns confirmed
  rendering; #7 ICS feed confirmed valid RFC-5545 live. Fix-it-right: the ICS event SUMMARY now
  humanizes service_type ("trash_pickup"→"Trash pickup"), unified onto a new shared
  `humanizeServiceType` (also adopted by AppointmentsPage, replacing its local copy). 18 calendar tests green.
- **Business #12(c)** — DriverPage is now `React.lazy` + Suspense in business main.tsx; maplibre-gl
  (+ RouteMapLive + CSS) split into a route-only chunk (222kb gz), confirmed OUT of the main index
  bundle (160kb gz). DriverPage still mounts (verified).
- **Business #11** — public booking now collects the customer's vehicle (Year/Make/Model/plate) when
  the business has `customer_vehicles`; book endpoint files it to business_customer_vehicles (all
  branches). Verified live (2020 Ford F-150 → row created). 22 publicBooking tests. **BUSINESS CLUSTER
  NOW COMPLETE** (only [~] deferrals remain: #12(d) native app, #15 geocoder self-host).
- **Landlord #15 (core)** — clicking a CONFIRMED lease opens read-only (LeaseFormModal `readOnly` prop;
  one `<fieldset disabled>` makes all 17 fields :disabled, title "Lease details", Close-only, no Save);
  needs-review imports stay editable. Verified live. REMAINING: "+ move-in pics" (needs a
  lease→unit_inspections(move_in)→unit_inspection_photos endpoint — none exists yet).
- **Landlord #8b** — eviction mode (units.payment_block) now blocks the tenant-initiated
  POST /payments/:id/pay (landlord-bound destination charge) with a clear 409; GAM-side balances
  (FlexDeposit etc.) keep collecting. Nic's rule: eviction blocks ALL money routed to the landlord
  (acceptance can reset the eviction clock). 31 payments tests (1 new).

**New since first save:** migration count is unchanged (no new migrations this resume). New shared export
`humanizeServiceType`. tsc green across api/business/customer/landlord. All touched test suites green.

**Next (Landlord cluster, in progress):** #20 clickable monthly P&L, #30 applicant pool by proximity,
#15 move-in pics, #7 onboarding in-browser form, #10 Master Schedule (big), #12 dup payment-health card,
#23/#24 inspections, #29 work-trade, #5 agent-David verify. Marketing stays LAST.

---

## Theme
Worked the **WALKTHROUGH_CHANGES.md Business cluster** top to bottom. Shipped #3,
#4, #5, #6, #7, #8, #9 plus a **recurring/route-aware booking redesign** (the big
one — booking now enrolls customers into recurring schedules). Live-tracker
(`WALKTHROUGH_CHANGES.md`) has the item-level detail; this is orientation + the
decision trail.

All work uncommitted (Nic decides commits — don't raise git). **api + business +
customer all `tsc --noEmit` green.** 4 migrations applied. New/changed surfaces
carry passing tests (counts per item below).

## Migrations applied this session (4)
- `20260622120000_recurring_invoice_intervals.sql` — widened
  business_recurring_invoice_schedules frequency + cadence CHECKs (quarterly/
  semiannual/annual).
- `20260622130000_business_calendar_feed_token.sql` — businesses.calendar_feed_token
  (lazy, rotatable) for the appointments ICS feed (#7).
- `20260622140000_business_invoice_deposits.sql` — business_invoices.deposit_amount/
  deposit_type/deposit_paid_at + new **business_invoice_payments** ledger
  (per-payment, UNIQUE(stripe_checkout_session_id) = webhook idempotency).
- `20260622160000_bookable_service_recurrence.sql` — business_bookable_services.
  recurrence + recurrence_day_of_week.

## Shipped (per walkthrough item)
- **#3 camelize audit** — no silent-undefined bugs found; unified the business
  dashboard A/R-aging off the lossy `d1_30→d130` artifacts onto the Reports page's
  clean `d1to30/...` scheme. 18 dashboard tests green.
- **#4 billing intervals** — quarterly/6-month/yearly recurring invoices. Shared
  `RECURRING_INVOICE_FREQUENCIES` + month-step + rrule-free month math. 19 tests.
- **#5 recurring line qty/price** — detail already had the table; added live
  per-line subtotal to the create form.
- **#6 generalize Quotes** — vehicle UI now gated on the `customer_vehicles`
  feature (was inferred from a 403); "Convert to work order" gated on `work_orders`.
- **#7 calendar + sync** — `apps/api/src/routes/publicBusinessCalendar.ts` serves a
  private one-way **ICS subscribe feed** (`/api/public/business-calendar/:token.ics`,
  webcal — works in Google/Apple/Outlook, no paid OAuth, data stays on GAM). Token
  lazily minted + rotatable. Also humanized appointment `service_type` display
  (`trash_pickup`→`Trash pickup`) in AppointmentsPage. **VERIFY NEXT SESSION:** I
  did not re-confirm the owner-facing "subscribe URL / copy + rotate" UI panel end
  to end — check `apps/business` Appointments/Settings for the sync panel and that
  the ICS validates in a real calendar client.
- **#8 hosted self-booking site** — built the public site (backend was already
  done) in the **customer app (:3014)** at `/book/:slug`. Fixed the owner share URL
  (Settings) to point at the customer app (`VITE_CUSTOMER_PORTAL_URL`, default :3014)
  not the static marketing site. Verified live end-to-end.
- **#9 deposits (full online deposit-then-balance)** — the real money-flow rework.
  Deposit on the invoice (service|materials label), two-stage Checkout (send +
  portal mint a session for the amount-due-now with `payment_kind` metadata), and
  the webhook idempotently records each payment in the ledger, recomputes
  `amount_paid = SUM(ledger)`, stamps deposit_paid_at, flips to paid only when the
  total is covered. Owner create + detail banner; customer "Pay deposit $X" →
  "Pay $Y balance". 10 tests (5 webhook incl. idempotency/double-credit, 3 create
  validation, 2 portal). **LAUNCH:** needs live Stripe **test-mode keys** to exercise
  the hosted Checkout (webhook crediting is unit-proven via simulated events).

## The recurring/route-aware booking redesign (read this — Nic-steered)
Nic's correction: a customer booking "Weekly trash pickup" must land on a
**recurring schedule**, and for **route businesses the customer picks a DAY, not a
time** — the route optimizer sets the time. Locked model:
- **Route businesses only** (have the `routing` feature) book by day; non-route
  businesses keep the time-slot picker.
- **Owner fixes cadence + day per service** (one_time/weekly/biweekly/monthly +
  day-of-week). Customer enrolling in a recurring service just signs up — no day pick.
Implementation:
- `business_bookable_services.recurrence` + `recurrence_day_of_week` (owner sets in
  BookableServicesPage). Shared `BOOKABLE_SERVICE_RECURRENCES` + `bookableServiceRrule`
  (weekly INTERVAL=1, biweekly =2, monthly =4, all `FREQ=WEEKLY;BYDAY=<dow>`).
- `publicBooking.ts`: profile returns `booking_mode` ('day'|'slot') + per-service
  recurrence; availability has a **day mode** (returns open days, not slots); **book**
  branches: recurring → INSERT into `recurring_schedules` (the materializer cron then
  generates appointments — verified: enroll creates the schedule, 0 one-off appts),
  one-time route → day-level appointment, non-route → slot appointment.
- Booking page (customer app) has 3 flows: recurring "enroll" banner, route day-picker,
  non-route slot-picker. **VERIFIED LIVE:** recurring enroll → `recurring_schedules`
  row (FREQ=WEEKLY;INTERVAL=1;BYDAY=TU, active, start next Tue); one-time route →
  day picker, no times (screenshot taken). 20 publicBooking tests green (5 new).
- **VERIFY NEXT SESSION:** owner BookableServicesPage cadence/"Repeats on" dropdowns
  are built + tsc-clean, but my last live DOM check didn't confirm the edit-modal
  fields rendered (flaky browser nav, not a known bug). Quick visual confirm needed.

## New files
API: `routes/publicBusinessCalendar.ts`, `routes/businessInvoiceDeposit.webhook.test.ts`,
4 migrations. Customer app: `pages/BookingPage.tsx` (+ `/book/:slug` route in main.tsx).
Shared: deposit + recurrence + recurring-invoice-frequency consts/helpers in
`packages/shared/src/index.ts` (rebuild shared after pulling: `cd packages/shared && npm run build`).

## Demo data seeded (so the features demo live — leaveable or cleanable)
- Acme Hauling: `public_booking_slug='acme-hauling'`, booking enabled, intro set.
  Bookable services: "Weekly trash pickup" (weekly, **Tuesdays**, $25) + "Bulk
  haul-away" (one-time, $150).
- `INV-DEP1` — $1000 invoice, $300 **materials** deposit (shows the deposit banner).
- Test bookings: "Dana Booker" (one-time appt), "Rita Recurring"
  (rita.recurring@example.com → a recurring_schedule).

## Remaining / next session
- **Business cluster:** #10 POS-tab SSO (NEEDS NIC'S PRODUCT CALL on the auth path —
  business_owner isn't a landlord, standalone POS needs an SSO path); #11 the
  **vehicle-intake slice** (booking already covers customer self-entry; remaining is
  the auto-shop VIN/make/model self-entry on work orders); #12(c) lazy-load DriverPage
  (MapLibre ~380kb gz perf).
- **Verify passes (flagged above):** #7 owner ICS subscribe panel + real-calendar
  validation; owner BookableServices cadence dropdowns.
- **Other clusters still open:** Fitness (6), Landlord walkthrough (#5,7,8b,10,11,12,
  15,20,23,24,29,30,31,32), Marketing (LAST), Operations/Admin/PM/POS smaller items.
- **Launch-infra bucket (do together):** Stripe **test-mode keys** (deposits hosted
  Checkout), VAPID keys + HTTPS (Web Push + booking secure context),
  `VITE_CUSTOMER_PORTAL_URL`, self-host Nominatim/OSRM/map tiles.

## How to resume
- Start: API `cd apps/api && npm run dev` (:4000); customer app `cd apps/customer &&
  npm run dev` (:3014); business `apps/business` (:3012). NOTE: the API + customer
  dev servers went down mid-session and I restarted them via Bash — `~/gam-start.sh`
  is the full boot. I added a **customer** entry to `.claude/launch.json` (:3014) but
  the preview tool had cached the old list; a fresh tool session will pick it up.
- Demo logins unchanged (business `owner@business.dev`/`business1234` = Acme Hauling).
- Public booking page: `http://localhost:3014/book/acme-hauling`.
- Tests (key suites, all green this session): `cd apps/api && npx vitest run
  src/routes/publicBooking.test.ts src/routes/businessInvoiceDeposit.webhook.test.ts
  src/routes/businessInvoices.test.ts src/routes/businessRecurringInvoices.test.ts
  src/routes/publicCustomerPortal.test.ts src/routes/businessDashboard.test.ts`.
