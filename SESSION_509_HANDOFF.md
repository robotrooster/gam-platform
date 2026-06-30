# SESSION 509 HANDOFF

## Theme
Business **route-ops cluster** (WALKTHROUGH_CHANGES.md → Business #12–16) plus a
new **customer portal**. Nic reframed the driver model mid-session: **drivers
don't tap buttons per stop** — stops auto-complete on a timer; Skip is the only
manual driver action. Customers get a **login portal** to see service status.

All work is uncommitted (last commit S496; Nic decides commits — don't raise git).
api + business + customer all `tsc --noEmit` green. New behavior is covered by
**18 new passing tests** (5 route auto-advance + 13 customer portal). No migrations
this session — the timer reuses existing `route_stops` columns.

## Nic-confirmed decisions (this session — they override earlier menu options)
- **Drivers never tap per stop.** Stops auto-complete on a **timer**, not GPS
  (GPS was rejected: web app can't see GPS in the background once the driver
  opens their Maps app). Formula: each stop completes at
  `previous-stop-finalized + planned-drive-leg + 1 min`, re-anchored to reality
  each leg. **Skip is the driver's only button** (and can override a stop the
  timer already auto-completed).
- **#13 map = option C:** in-app SVG plot (NOT built yet) + one **"Open full
  route in Maps"** deep-link (BUILT) that loads every remaining stop in order
  **by street address** (iOS→Apple Maps, else Google path form). Addresses, not
  lat/lon, because Google/Apple geocode better and it sidesteps our Nominatim.
- **Customer notifications = "customer portal login"**, NOT email/SMS push. A
  customer logs in (magic-link) and pulls their status. Trigger surfaces are
  **completion or skip**. Because it's pull-only, a wrong auto-complete the
  driver then skips just updates the page — no erroneous push goes out.
- **Customer portal frontend = new standalone app** (`apps/customer`, :3014),
  matching the one-app-per-audience monorepo pattern (not folded into the
  static marketing site, which is slated for its own overhaul).

## Shipped (verified)
### Driver side — "no-tap" model
- **`apps/api/src/jobs/routeAutoAdvance.ts`** (new) + registered every-minute in
  `jobs/scheduler.ts` (`* * * * *`). Auto-completes in_progress route stops in
  sequence on the timer above; propagates `appointments.status='completed'` +
  `completed_at`; auto-completes the route when stops are exhausted. Catch-up &
  idempotent. Matches the optimizer's absolute-timestamp model exactly
  (verified against `services/routeOptimizer.ts`). 5 tests.
- **`apps/business/src/pages/DriverPage.tsx`** — removed the per-stop "Complete"
  and "I've arrived" buttons; **Skip is the only button**. Replaced the per-stop
  Google deep-link (reloaded each stop) with one **"Open full route in Maps"**
  (new `fullRouteMapsUrl` by address, iOS/Google split).
- **`routes.ts` skip endpoint** — now accepts `planned` OR `completed` while the
  route is in_progress (driver override of a timer-completed stop), stamps
  `actual_departure` to re-anchor the next leg, flips appointment → `no_show`.
  (The `/arrive` endpoint I briefly added was reverted — contradicts no-tap.)

### Customer portal (new)
- **Backend** (`routes/publicCustomerPortal.ts`, reuses S502 token system):
  - `GET /api/public/customer/:token/service` — appointments with state
    (completed/skipped/scheduled/cancelled) + completion/skip timestamps + skip
    reason; customer-scoped.
  - `POST /api/public/portal-login/:slug` — magic-link login: email → portal
    link via Resend, enumeration-safe (same 200 regardless of match).
  - `services/email.ts` → new `emailCustomerPortalLink`.
  - `services/customerPortalTokens.ts` + `publicCustomerPortal.ts` pay redirects
    repointed `MARKETING_URL` → new `CUSTOMER_PORTAL_URL` (default :3014).
  - 13 tests.
- **Frontend** — new app **`apps/customer`** (:3014): `/login/:slug`,
  `/account/:token` (service status + invoices + Pay), `/` landing. Dark/gold
  theme. tsc + prod build clean (168 kB).
- **Wiring:** `apps/api/src/index.ts` CORS adds :3014; `dev.sh` boots it
  (port-kill loop, launch line, URL echo, lsof check); `npm install` registered
  the workspace.

## Files touched
NEW: `apps/api/src/jobs/routeAutoAdvance.ts` (+ `.test.ts`);
`apps/customer/**` (package.json, vite.config.ts, tsconfig{,.node}.json,
index.html, src/main.tsx, src/styles.css, src/lib/api.ts,
src/pages/LoginPage.tsx, src/pages/AccountPage.tsx).
EDITED: `apps/api/src/jobs/scheduler.ts`, `apps/api/src/routes/routes.ts`,
`apps/api/src/routes/publicCustomerPortal.ts` (+ `.test.ts`),
`apps/api/src/services/email.ts`, `apps/api/src/services/customerPortalTokens.ts`,
`apps/api/src/index.ts`, `apps/business/src/pages/DriverPage.tsx`, `dev.sh`,
`WALKTHROUGH_CHANGES.md`.

## Remaining in this cluster (next session)
1. **Owner "share portal link" button** (recommended next — small, closes the
   loop). The portal link is mintable + emailable today, but the business portal
   has no button to hand a customer their `/login/:slug` or direct `/account/:token`
   link. Also decide: owner-invites vs. customers self-serve via the slug page.
2. **#13 in-app SVG plot** — the in-app overview half of option C (plot stops
   from lat/lon as a numbered, sovereign diagram; no tiles). Note: DriverPage
   GET /:id payload has customer/dump lat/lon but NOT depot lat/lon — add
   `d.lat/d.lon` to the route header query if the SVG needs the depot point.
2.5 **Customer app polish** — add an `/invoice-paid` route (Stripe successUrl
   currently falls through to the landing redirect).
3. **#14 live insert** into a generated/locked route (re-sequence + recompute
   timing; mind the `route_stops_unique_sequence (route_id, sequence_order)`
   constraint — reorder via a temp offset).
4. **#16 pre-start reorder** ("work back toward transfer station") — manual
   reorder of a `generated` route before start.
5. **#15** — deploy infra only (stand up Nominatim); app code already reads
   `GEOCODER_URL` and the Maps deep-link navigates by address.

## How to resume
- `~/gam-start.sh` boots everything incl. the new Customer app (:3014).
- Customer portal demo: log in at `http://localhost:3014/login/<business-slug>`;
  Acme Hauling's slug is whatever `public_booking_slug` is set to (check
  `SELECT public_booking_slug FROM businesses WHERE name='Acme Hauling'`). The
  magic-link emails only fire with a real `RESEND_API_KEY`; in dev, mint a token
  directly and hit `http://localhost:3014/account/<token>`.
- To watch the timer: generate + start a route (business :3012 → Routes), then
  the `* * * * *` cron auto-completes stops; or call `processRouteAutoAdvance()`
  with an injected `now` (see the test).
- Tests: `cd apps/api && npx vitest run src/jobs/routeAutoAdvance.test.ts
  src/routes/publicCustomerPortal.test.ts`.
