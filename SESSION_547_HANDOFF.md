# SESSION 547 HANDOFF

## Theme
The storefront grew from a booking page into full per-property WEBSITES
(subdomain sites for RV parks / motels / Airbnb portfolios), plus the
long-stay billing model, screening decision flow, guest amenity booking
behind stay links, and a stack of anti-friction/anti-abuse rules. All
Nic-driven, all verified live against dev with test data cleaned after.

## 1. Storefront → full property website (apps/storefront :3015)
- Multi-page per property: **Home** (hero, intro, photo strip, amenities,
  inquiry form), **Gallery**, **FAQ**, **Contact**, **Book**, plus tokened
  **/stay/:token** and **/booked** pages. Sticky nav; Gallery/FAQ links
  only render when content exists.
- Migrations: property_site_photos + property_faqs (20260718172000/172100).
  Landlord editors live in Schedule → Booking Page (photo upload w/
  caption/remove via AuthThumb blob pattern; FAQ add/edit/delete).
  Public photo route sets Cross-Origin-Resource-Policy: cross-origin
  (helmet's same-origin default blocks cross-origin <img>).
- Public serving gated on public_booking_enabled (publish = opt-in);
  site photos are a SEPARATE table from unit_photos by design (public
  route can never reach internal media).
- Contact page (20260718200000): office_phone/office_email/office_hours on
  properties, set in Booking Page config; page shows phone/email/street
  address/hours + the inquiry form. Sunset Palms seeded with demo values +
  4 generated placeholder photos + 4 FAQs (repo unit photos are 10-byte
  stubs — no real images exist anywhere).

## 2. Dates-first booking + confirmation (Nic: "no friction")
- Booking page: dates → ONE availability call prices EVERY site type →
  available types render as pick-cards, full ones dim to waitlist.
  Auto-select when exactly one type is open. Inquiry form REMOVED from
  the book page (home/contact keep it); optional "Questions or requests"
  rides WITH the reservation (stored in unit_bookings.notes AND fanned
  out as a property_inquiry notification "Reservation question").
- API: GET /availability without siteTypeId returns all-types shape
  (typeAvailability helper); single-type shape unchanged (legacy customer
  portal). Response includes utilitiesBilled + per-type altStay.
- **Adaptive booking**: full type with a free prefix from the same
  check-in returns altStay {checkOut, nights}; UI shows "Open until X —
  shorten to N nights", one click re-checks. Respects min-stay.
- **Confirmation page**: Stripe success/cancel URLs + waitlist claim links
  now build from STOREFRONT_URL_TEMPLATE (default localhost:3015/{slug};
  prod = https://{slug}.gam.biz) — replaced the legacy customer-portal
  (:3014) URLs. /booked?booking=<id> polls the sanitized public status
  endpoint (GET /property/:slug/booking/:id) until the webhook confirms.
- **Dev-mock checkout**: outside production, a Connect-less landlord gets
  a simulated deposit (stamps mock_<id> session, confirms via
  confirmBookingDeposit) so the whole flow is walkable. Production always
  requires Connect (test pins NODE_ENV=production for the 409).
- Fixed en route: monthly-tier public bookings ALWAYS violated the
  lease_type CHECK (no 'monthly' value) — now stored as month_to_month.

## 3. Long-stay (30+ nights) model — Nic's spec
- **Calendar-aligned billing**: shared computeMonthlyStaySchedule —
  prorated arrival month (days × monthly/30), FLAT monthly for full
  calendar months (31-day month ≠ 31/30), prorated departure. Quote =
  schedule sum everywhere (public quote, public book, staff create, staff
  PATCH reprice) so quote/booking/invoices can never disagree.
- **Guest-facing quote is SLIM** (Nic: no scary $5k lump): "$950.00/month
  plus utilities · Due now $150 deposit" + one line about 1st-of-month
  invoicing with prorated first/last. No total shown to guests; the
  booking still stores it. "plus utilities" follows per-property
  booking_utilities_billed (20260718191100, default TRUE, toggle in
  Booking Page config).
- **Deposits split by stay length** (20260718184500): % of total for <30
  nights ONLY; monthly stays owe FLAT booking_monthly_deposit (default
  $150 = shared BOOKING_MONTHLY_DEPOSIT_DEFAULT, per-property setting),
  HARD-CAPPED at one month's rent per site type (verified: $2000 flat
  clamped to $950/$850). Compliance framing: long-term guests never owe
  more than a month up front.
- **Lease draft**: public 30+ bookings now call maybeDraftLeaseFromBooking
  (S526 parity). Notification is a DECISION ping: "screen or send the
  lease" + guest history (prior stays; approved GAM check + continuous
  tenancy since = "no new check needed"; continuity = lease_tenants chain,
  30-day grace, any GAM landlord) + fair-housing consistency wording.
  NO auto-emailed checks — landlord clicks "Request screening" on the
  booking_draft lease row (LeasesPage) → appConfirm with consistency note
  → POST /leases/:id/request-background-check → emailBackgroundCheckScreeningRequest
  to the guest (tenant-portal /background flow). NOT auto-sent to guest.
- DEFERRED (next session, billing engine): 1st-of-month invoice
  generation for booking-drafted leases w/ prorated first/final invoices;
  schedule-change → recompute owed; paid-beyond-new-end credit netted
  against the final meter-read bill. invoiceGeneration.ts currently bills
  full months on rent_due_day, no proration.

## 4. Snowbird site lock (20260718191000)
- unit_bookings.locked_to_unit; "Lock to site" button in the Master
  Schedule reservation detail (gold 🔒 when on). Exempt from ALL movers:
  compressor (pinned), relocateBlockingBookings (refuses), extend
  fallback (locked extender fails on conflict instead of moving).

## 5. Guest amenity booking — BEHIND THE STAY LINK (Nic's call)
- Options weighed (tenant-portal accounts / public gate / stay link);
  Nic picked stay link. Public homepage is INFO-ONLY ("Guests can
  reserve" tag) + "Staying with us?" resend box (POST /stay-link, always
  success — no email enumeration).
- Every public booking auto-emails the stay link (emailGuestStayLink →
  storefront /stay/<token>; token = booking_guest_access_tokens, expires
  check_out+2d). Storefront /stay/:token page: stay summary + amenity
  cards WITH reserve (date/times/guests/private-event/notes).
- API: GET /property/:slug/stay/:token; POST
  /property/:slug/stay/:token/amenity/:areaId/reserve — reuses tenant
  machinery (validateWindow, advisory-lock conflict, approval posture,
  fireAmenityAlert, notifyReservationRequested). Fees recorded, collected
  at the office (no guest payment rail until Stripe).
- Schema (20260718200100/200200): common_area_reservations.guest_booking_id,
  created_by_user_id now nullable + actor CHECK; kind 'guest_reservation'
  added (shared enum + car_kind_check migration + KIND_LABEL 'Guest').
  Landlord reservations list joins unit_bookings for guest names.
- **Advance-cap skip**: guests booking through their stay link skip
  advance_booking_days (their stay window is the bound) — a booking made
  6 months out can reserve the pool for that week immediately. Tenants
  still capped. validateWindow gained {skipAdvanceLimit}.
- **Per-person monthly cap** (20260718204000): common_areas.
  monthly_reservation_limit ("Max / person / month" in the area editor,
  chip on the area card). assertMonthlyReservationLimit enforced for
  tenants AND guests (pending+approved in the calendar month; landlord
  holds exempt). Verified: cap 2 → third daily pool hold rejected.
- Note: staff-issued QR/stay-assistant links still point at marketing
  /stay/<token> (the guest agent chat); same token works on both surfaces.
  Unify onto the subdomain at the marketing rebuild.

## Decisions (Nic)
- One clean default website template under the GAM aesthetic; porting
  existing sites + webhooks = future. Custom themes later.
- $150 default monthly-stay deposit ("150 or 200, whatever") — cap at one
  month is the compliance point.
- Never auto-send background checks; landlord decides per stay with the
  consistency/discrimination warning; returning-guest history informs.
- Amenities must never look publicly bookable.

## Files touched (S547)
api: 10 migrations (site photos, faqs, monthly deposit, locked_to_unit,
utilities note, office contact, guest reservations ×2 + kind, monthly
limit); routes/publicPropertyBooking.ts (heavy — availability all-types,
booking status, photos/faqs/contact in profile, photo stream, stay/token
endpoints, stay-link resend, amenity reserve, inquiry helper, note
fan-out); routes/propertyBookingAdmin.ts (site-photos + faqs CRUD, authed
thumb route, config: monthlyDeposit/utilitiesBilled/office*);
routes/units.ts (lock, monthly reprice, staff-create monthly total);
routes/leases.ts (request-background-check); routes/commonAreas.ts
(exports, guest name join, monthly limit); services/propertyBooking.ts
(storefrontUrl, monthly quote/deposit, mock checkout, lease draft + stay
link on public book, notes col); services/bookingLeaseDraft.ts (screening
context + decision ping); services/commonAreas.ts (assertMonthlyReservationLimit);
services/email.ts (emailGuestStayLink, emailBackgroundCheckScreeningRequest);
shared: computeMonthlyStaySchedule, BOOKING_MONTHLY_DEPOSIT_DEFAULT,
'guest_reservation' kind. storefront/src/main.tsx (rewritten: pages, nav,
dates-first, slim monthly quote, adaptive, stay page, amenity cards,
StayLinkBox, contact). landlord: SchedulePage (Booking Page config grew:
deposits/utilities/contact/photos/FAQs; lock button + mutation;
storefront preview URL), LeasesPage (Request screening), AmenitiesPage
(guest label/name, monthly-limit field + chip).

## Watchouts
- STOREFRONT_URL_TEMPLATE unset in prod → links default to localhost:3015.
  Set https://{slug}.gam.biz at storefront prod wiring (with wildcard DNS,
  captcha, Stripe-return page — the existing prod-wiring pile).
- Dev-mock checkout keys off NODE_ENV!=='production' + no Connect. The
  dev stack serves prod traffic via the tunnel until the launchd flip —
  the flip (existing prelaunch item) closes that hole.
- propertyBookingFlow tests set NODE_ENV='production' inside one test —
  keep the restore-in-finally pattern if extending.
- vitest suites relevant here: publicPropertyBooking, propertyBookingFlow,
  propertyBookingAdmin, booking-lease-draft, commonAreas,
  scheduleCompression (all green at close; 48+28 across final runs).
- Demo data intentionally left: Sunset Palms placeholder photos/FAQs/
  office contact, Clubhouse events_enabled + $50 event deposit. All
  session test bookings/reservations/tokens/notifications deleted.

## Next session targets
1. Long-stay billing engine (the deferred piece of Nic's spec): calendar
   invoices for booking-drafted leases, prorated first/final, Master
   Schedule sync → credits netted against final meter read.
2. Storefront prod wiring: wildcard *.gam.biz DNS, STOREFRONT_URL_TEMPLATE,
   captcha/rate limiting, landlord inquiry inbox page (property_inquiries
   has handled_at waiting for a surface).
3. OCR path for FlexPay photo proofs (S546 carryover).
4. Nic-gated: Stripe live keys → real deposit checkout end-to-end;
   Checkr; DoorLoop export.
