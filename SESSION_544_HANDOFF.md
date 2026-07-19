# SESSION 544 HANDOFF

## Theme
Two Nic directives: (1) FlexPay becomes a pre-launch "coming soon"
INTEREST SURVEY (no enrollment promises until launch), (2) the guest
storefront — customer-facing per-property websites (subdomains) for RV
reservations, availability, amenities, inquiries — SHIPPED v1.

## 1. FlexPay survey mode (S544)
- New flag `flexpay_enrollment_open` (migration 20260718100000,
  DEFAULT OFF). Two-flag model: rollout_visible = surface exists;
  enrollment_open = LAUNCHED. OFF = survey mode (current dev state).
- enrollFlexPay refuses while closed — even APPROVED tenants ("hasn't
  launched yet"); server-enforced, test-pinned (launch flip → same
  tenant enrolls).
- Tenant portal in survey mode: card copy "Coming soon — take the
  30-second interest survey" / CTA "Take the survey" → survey-framed
  modal ("isn't a signup, doesn't guarantee availability") → after:
  "✓ Interest recorded — we'll announce availability" badge. NO queue
  language, NO reach-out promises, NO proof-of-income card (no
  document requests for an unlaunched product). Questionnaire
  confirmation copy softened to no-promise phrasing (both modes).
- Survey submissions are ordinary flexpay_inquiries rows — demand
  data, float-need ordering, and the admin queue all keep working.
- **Launch procedure:** flip flexpay_enrollment_open ON (with Stripe
  live keys + bankroll) — everything else is already wired.
- Tests: s541 suite now 6 cases (11/11 with s542). Verified live:
  alice's card shows "Interest recorded", no proof card.

## 2. Guest storefront — NEW APP apps/storefront (port 3015)
**The S517/W-20 public booking API already existed** (slug-keyed,
subdomain-ready: profile, availability quote, book → Stripe deposit
checkout, waitlist, claim; landlord config = BookingSitesPage;
bookings write unit_bookings → Master Schedule automatically). S544
built what was missing:

### API additions (routes/publicPropertyBooking.ts)
- Profile now includes `amenities` — the property's active
  common_areas (name/description/capacity/hours only; reservations
  stay resident-side).
- POST /property/:slug/inquiry — anonymous contact form → NEW table
  property_inquiries (migration 20260718110000) + landlord
  notification with email (type 'property_inquiry', message inline).
- CORS: localhost:3015 + *.gam.biz origins allowed (STOREFRONT_HOST).

### The app (single-file src/main.tsx, dark/gold, mobile-first)
- ONE deployment serves every property. Slug = subdomain in prod
  ({booking_slug}.gam.biz), first path segment in dev
  (localhost:3015/sunset-palms). Claim links: /claim/:token (prod) or
  /:slug/claim/:token (dev).
- Sections: hero (name/city/intro), site-type cards with rates,
  date picker → availability quote (auto-tiered price, lodging tax,
  deposit due now), guest form → Reserve → Stripe checkout redirect;
  full dates → waitlist join; claim landing view; amenities grid;
  inquiry form; "Reservations powered by Gold Asset Management".
- W-20 respected: site TYPES only, "your exact site number is
  assigned and emailed the morning of check-in".
- S540 rules followed: self-hosted @fontsource fonts, tab-resilience
  script (13th copy), host:true dual-stack.
- Registered in BOTH launch.json files (repo .claude + home) as
  "storefront". NOT in the launch set (start on demand).

### Verified live against sunset-palms (dev)
- Profile/hero/rates/amenities (Clubhouse, Pool) render; availability
  quote correct ($218.40 = 3 nights × $65 + $23.40 lodging tax,
  $54.60 = 25% deposit); Reserve surfaces the expected 409 ("not
  accepting online deposits yet" — james@demo.dev has no Stripe
  Connect in dev; gate lifts with Connect onboarding); inquiry
  round-trip proven (property_inquiries row + landlord notification)
  then test rows deleted. Existing suites 22/22
  (publicPropertyBooking + propertyBookingFlow).

## Port note
Storefront is **3015** (3013 = fitness, 3014 = customer per
launch.json — CLAUDE.md's port table doesn't list those two).

## Decisions
- Nic: FlexPay = coming-soon survey until launch; storefront build
  green-lit (reservations auto-import to calendar — already true via
  unit_bookings).
- Claude (flag if wrong): storefront stays out of the launch set;
  amenities exposed = active common_areas only; inquiry has no
  captcha yet (length caps only — add rate limiting before prod
  wildcard DNS goes live); GAM dark/gold theme for v1 (per-park
  branding is a future layer).

## Files touched
api: migrations 20260718{100000,110000} (applied), services/flexpay.ts
(enrollment gate), routes/tenants.ts (enrollmentOpen), routes/
publicPropertyBooking.ts (amenities + inquiry), index.ts (CORS),
routes/s541-flexpay-inquiry.test.ts (+1 case).
tenant: main.tsx (survey mode states/copy, proof card gated).
NEW: apps/storefront/* (package.json, vite.config, tsconfig,
index.html, src/main.tsx). launch.json ×2 (storefront entry).

## Next session targets
1. Prod wiring for storefronts: wildcard *.gam.biz DNS + Cloudflare
   tunnel route → :3015 (or Vercel with wildcard domain), plus
   inquiry rate-limiting/captcha before public exposure.
2. Landlord-side inquiry inbox (property_inquiries surface +
   handled_at flow) — notifications carry messages meanwhile.
3. Storefront polish batch (photos, per-park branding/colors, SEO
   meta, booking-confirmation return page after Stripe checkout).
4. Nic-gated: approve alice; Stripe live keys → S520 flip +
   flexpay_enrollment_open at FlexPay launch; Checkr; DoorLoop.

## Watchouts
- Booking deposit checkout requires landlord Connect — storefront
  Reserve 409s until then (correct behavior; message shown to guest).
- The storefront intentionally has NO auth — it's the one public
  surface class (bookings/inquiries). Never mount authed data there.
- CLAUDE.md port table is stale for 3013/3014 (fitness/customer) and
  doesn't list 3015 yet.
