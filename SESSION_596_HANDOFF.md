# SESSION 596 HANDOFF — Demo booking (built, tested, DEPLOYED + LIVE) + marketing copy pass

> The demo-booking feature is **LIVE on goldassetmanagement.com** and verified
> end-to-end (modal → survey → real slots from api.goldassetmanagement.com).
> 14 tests pass. Nic reviewed the modal ("form looks good") and said go live.
> Also this session: a `server.js` fix that injects `GAM_API_BASE` (the homepage
> could never reach the API cross-origin — this also silently fixed Lucy's chat
> on the live site), and a marketing copy pass (de-RV the framing). Remaining
> ("later today", need Nic): `API_PUBLIC_URL` for the calendar feed, Nic's
> one-time calendar subscribe, Jitsi self-host (§LATER).

---

## ⏳ LATER TODAY (need Nic) — the rest was built + verified LIVE this session

Done + live: modal reviewed ("form looks good") → **deployed**; the booking flow
works on goldassetmanagement.com (real slots, Jitsi rooms, prospect confirmation
+ owner heads-up email fire in prod). Marketing copy broadened off the RV-only
framing (your 2 exact lines — eyebrow "…your entire portfolio", title "Run your
entire operation…" — plus a de-RV pass on the sub-headline, both reasons, the
title tag, and the footer). Every booking already emails nic@golddoor.io, so
you're notified even before the calendar subscribe below.

Also fixed a latent bug: the homepage could never reach the API cross-origin
(marketing is goldassetmanagement.com, API is api.goldassetmanagement.com) — same-
origin `/api` hit the static server. `server.js` now injects
`window.GAM_API_BASE` from `API_URL`. **This silently repaired Lucy's sales chat
on the live site too** (it had the same bug).

1. **`API_PUBLIC_URL` for the calendar feed** — value now known: set
   `API_PUBLIC_URL=https://api.goldassetmanagement.com` in `apps/api/.env`
   (needs your OK, it's a `.env`) + restart the API. Until then the admin
   "Add to calendar" URL shows localhost. (The feed already serves at
   `api.goldassetmanagement.com/api/public/sales-calendar/<token>.ics`.)
4. **Subscribe your calendar (one-time, ~30 sec).** After go-live, the Admin
   portal → **Sales Leads** page shows a "📅 Subscribe once" banner with an
   **Add to calendar** button (webcal link) + the raw URL. Click it once in
   Apple Calendar; set auto-refresh to every 15 min *on your Mac* (iCloud-hosted
   subscriptions refresh lazily — hours — so prefer "On My Mac" for speed; the
   instant heads-up email covers awareness regardless).
5. **Jitsi self-host — the infra decision (needs your network/DNS).** You OK'd
   self-hosting for the brand (`meet.goldassetmanagement.com`). It's a standard
   `docker-jitsi-meet` stand-up, but the video bridge needs a reachable **UDP
   port 10000**, and the Cloudflare HTTP tunnel does **not** carry UDP. Pick one
   (morning):
   - (a) **Port-forward UDP 10000** on the Mac Studio's network → needs router
     access (your action). Cheapest.
   - (b) **Run Jitsi on a small cloud VM** (~$5–10/mo) with a public IP →
     cleanest, no home-network exposure. My recommendation.
   - (c) Stay on **public `meet.jit.si`** for now (it already works) and defer
     self-host. Zero cost, zero infra — just not our brand on the URL.
   Until we flip it, the feature runs on public Jitsi. When ready, I set
   `JITSI_BASE_URL=https://meet.goldassetmanagement.com` (one env, no code
   change) and every new booking uses our domain.

Everything else below was done tonight and needs nothing from you.

---

## What shipped (all code complete + tested; STAGED)

Marketing "Book a demo" → **survey (~1 min) → pick a 30-min slot → onto your
calendar + a video link**, exactly the flow we designed:

- **Window:** Mon–Fri **1:00–4:00 PM America/Phoenix**, six slots on the
  half-hour (1:00 … 3:30). Each is a **20-min** calendar event → a 10-min gap
  between calls (notes / bathroom / transition).
- **Lead buffer 1 hour** (1:00 slot closes at noon). **Once past 1 PM, today is
  closed → next day** (your "book during the window → next day" rule).
- **Video:** a **unique Jitsi room per booking**, auto-embedded in the calendar
  event + both emails. Runs on public `meet.jit.si` now; one env flips it to our
  self-hosted domain.
- **Auto-calendar:** you subscribe **once** to a private webcal feed; every
  booking auto-appears. Plus an **instant heads-up email** to `nic@golddoor.io`
  per booking (so refresh lag can never make you miss one) — carrying the survey
  brief (property mix / rough units / pain points) so you walk in prepped.
- **Prospect** gets a confirmation email with the join link **and a `.ics`
  attachment** for their single event.
- **Survey:** name/email/phone + "what do you manage?" (multi) + rough units
  (range) + "what's got you looking?" (multi + free text). Stored on the lead
  for pre-call prep.

### The key architecture decision (recon caught a redundancy)

The §7 handoff specced a brand-new `demo_bookings` stack. Recon found **S553
already built the whole 30-min slot engine** (Lucy's "book a call") — race-safe
booking, availability windows, TZ math, lead capture, reminder cron, admin view.
Building the specced parallel stack would have been two booking systems to keep
in sync. Instead I **reused + generalized the S553 engine** with a `kind`
discriminator (`demo` live; `onboarding` reserved for your post-signup
walkthrough window — slots in later with no rewrite). One engine, one calendar,
one admin queue. (Confirmed with Nic before building.)

---

## Files touched

**DB (migrations applied to the `gam` dev/prod DB tonight — additive, safe with the running old API):**
- `apps/api/src/db/migrations/20260807120000_demo_booking_kind_and_meeting_url.sql` — `kind` on `sales_call_availability` + `sales_call_slots` (CHECK demo|onboarding), `meeting_url` on slots; reseed availability → Mon-Fri 13:00-16:00 kind=demo.
- `apps/api/src/db/migrations/20260807120100_sales_calendar_feed_config.sql` — `sales_calendar_feed` singleton (feed_token).

**Backend:**
- `packages/shared/src/index.ts` — `SALES_BOOKING_KIND_VALUES = ['demo','onboarding']` (+ type). **Rebuilt.**
- `apps/api/src/services/salesCalls.ts` — generalized by `kind`; per-kind config (30-min cadence, 20-min event, 1h buffer); "window-started → no same-day" rule; `groupSlotsByDay`; `generateMeetingUrl` (Jitsi, `JITSI_BASE_URL`-driven); `bookSalesCall` now writes kind/meeting_url/survey + fires demo emails.
- `apps/api/src/lib/ics.ts` — **new**, shared RFC-5545 primitives (escape/fold/UTC/assemble), extracted so feeds can't drift.
- `apps/api/src/services/demoCalendar.ts` — **new**, `buildSalesFeedIcs` (owner feed w/ survey brief in DESCRIPTION + Jitsi as LOCATION/URL) + `buildDemoBookingIcs` (prospect single-event attachment).
- `apps/api/src/services/email.ts` — **new** `sendDemoBookingConfirmation` (join link + .ics attach) + `sendDemoBookingHeadsUp` (owner brief). (Old `sendSalesCallConfirmation` is now unused — left in place; cleanup candidate.)
- `apps/api/src/routes/agent.ts` — `GET /api/sales/demo/slots` + `POST /api/sales/demo` (survey zod, dedicated `demoBookLimiter` 5/10min, server-side availability re-check).
- `apps/api/src/routes/publicSalesCalendar.ts` — **new** `GET /api/public/sales-calendar/:token.ics` (enumeration-safe token, timing-safe compare). Mounted in `index.ts`.
- `apps/api/src/routes/admin.ts` — call-slots list shows kind/meeting_url/metadata; availability GET/PUT **kind-scoped** (fixes: the old `DELETE FROM sales_call_availability` would have wiped other kinds' windows); **new** `GET /admin/demo-feed` + `POST /admin/demo-feed/rotate`.

**Frontend:**
- `apps/marketing/src/index.html` — the demo modal (survey → slot picker → confirmation), gold/black, textContent-only (XSS-safe), same API-base pattern as Lucy. All four "Book a demo" CTAs → `gamOpenDemo`; "Talk/Contact sales" stay on Lucy; killed the "15-min" copy.
- `apps/admin/src/main.tsx` — Sales Leads page: subscribe-feed banner (Add to calendar / copy / rotate), a **Type** column (Demo/Onboarding), refreshed copy.

**Tests (14 pass, `DB_NAME=gam_test`):**
- `apps/api/src/services/salesCalls.test.ts` — rewritten to the new spec + demo rules (1h buffer, same-day cutoff, kind scoping, 20-min Jitsi booking, lead capture, race).
- `apps/api/src/services/demoCalendar.test.ts` — **new**, pure ICS builders (folding, escaping, cancelled status).

---

## State / safety

- **NOT deployed.** Prod API runs the old `dist` (no demo routes); `com.gam.marketing` serves the old HTML from memory. Migrations *are* applied to the `gam` DB (additive; the old API ignores the new columns). Go-live = build+restart API + redeploy marketing (MORNING, after review).
- **All changes uncommitted** (this session's + the prior 24-file working tree). Nic decides commits.
- Verified: modal opens + survey/chips/validation/step-transition/graceful-error in a **throwaway** local preview (never touched live :3004). Slot math validated live (60 slots, 6/day, today correctly closed). 14 tests green. API + admin typecheck clean.

---

## Verification still owed at go-live (I'll do it once you OK deploy)
- End-to-end against the live API: real slots render in the modal, a booking POST lands a row + fires the prospect confirmation (.ics) + your heads-up, and the `.ics` feed serves + subscribes.
- One controlled test booking (prospect `@x.dev` so no real prospect mail; you'll get one real heads-up as proof), then delete the test row.

## Open flags / next
1. Go-live (build+restart+redeploy) after your design review + `API_PUBLIC_URL`.
2. Jitsi self-host (§MORNING item 5).
3. `sendSalesCallConfirmation` in email.ts is now dead — remove in a later pass.
4. Second sales rep (you mentioned it doubles capacity): current model is
   single-rep (the global unique-start index prevents you being double-booked
   across demo/onboarding). Multi-rep needs a rep/resource dimension — flagged,
   not built.
5. Still-pending from S595: signup → sales-rep assignment (§8); fitness
   `/register` 2FA exception + `/leaderboard` privacy; marketing attorney pass;
   whether to commit the working tree.
