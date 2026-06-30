# SESSION 510 HANDOFF

## Theme
Built out the **Business route-ops cluster end to end** (WALKTHROUGH_CHANGES.md
Business #12–16) plus a **customer portal with Web Push**, then iterated the
driver/GPS model heavily with Nic until it landed on a coherent, free, in-app
design. This was a long single-theme session — the live tracker
(`WALKTHROUGH_CHANGES.md`) has item-level detail; this handoff is orientation +
the decision trail.

All work uncommitted (last commit S496; Nic decides commits — don't raise git).
**api + business + customer all `tsc --noEmit` green.** 3 migrations applied.
Route/portal surfaces carry ~60 passing tests.

## The driver/GPS model — final, after several pivots (read this first)
Nic iterated this a lot; the LANDED design (don't regress to earlier ones):
- **In-app map is the driver surface.** `apps/business/src/components/RouteMapLive.tsx`
  renders a sleek **CARTO dark-matter** basemap (free, no key; `VITE_MAP_STYLE_URL`
  env-swap, self-host for launch) with the route, stops, and a live GPS dot. The
  app staying foreground is the whole point — it keeps the GPS watch alive.
- **Real visual turn-by-turn** (no audio — web can't): `services/routeDirections.ts`
  + `GET /routes/:id/directions` proxy **OSRM** (`OSRM_URL` env; public demo for
  dev) → road-following polyline + turn list with road names; the map draws the
  road path + a turn panel, GPS-highlighting the active maneuver. (The earlier
  straight-line/SVG version was scrapped — Nic: a map without turn indicators is
  useless. The lat/lon-only SVG was also scrapped earlier for contradicting
  "navigate by address.")
- **Arrival = truck STOPPED in the geofence** (GPS speed < 1.5 m/s, or 8s
  dwell-in-fence if speed unavailable). Fixes dense same-street false-triggers.
  Geofence is a FIXED ~45m code const (`ARRIVAL_GEOFENCE_M`), NOT owner-set
  (Nic). The `arrival_geofence_meters` column is now dormant.
- **Completion = real GPS DEPARTURE** (leave fence + 25m hysteresis → POST
  /complete). `jobs/routeAutoAdvance.ts` is now a BACKSTOP only (arrived → +30min;
  never-arrived → +2h; depot on arrival) so a route can't hang.
- **Native-Maps arc deep-link kept** as a voice option (driver's choice). Maps
  cap a directions URL at ~10 stops, so a long day splits into arcs of
  `MAX_MAPS_STOPS`=10; the next arc loads as stops finalize.
- **Why not Google/Apple embedded or zero-tap:** Google/Apple Maps sites can't be
  iframed (X-Frame-Options); their JS SDKs cost money + send location to them
  (Nic scrapped paid). A web app can't background-GPS or self-foreground, so true
  zero-tap needs a NATIVE app (deferred). The in-app OSM map is the free path.

## Shipped this session (all verified)
### Driver / route ops (Business #12–16 — cluster closed except deploy infra)
- #12/#16 GPS arrival+dwell→departure model above (`routeAutoAdvance.ts` reworked,
  `routes.ts` /arrive + /position + /complete + /skip).
- #13 address Maps deep-link + arc-splitting + the in-app OSRM turn-by-turn map.
- #14 **live insert** — `services/routeInsert.ts` + `GET /routes/:id/insertable-
  appointments` + `POST /routes/:id/stops`; optimizer gained optional `startFrom`;
  "Add stop" modal on RoutesPage detail.
- #16 **pre-start reorder** — `services/routeReorder.ts` + `PATCH /routes/:id/stop-
  order`; ▲▼ arrows + "Reverse order" on RoutesPage (generated routes only).
- Live ETA — `services/routeEta.ts` + `POST /routes/:id/position` → `route_stops.
  projected_eta`; shown on the customer portal ("You're next — arriving ~2:45").

### Customer portal (`apps/customer`, :3014) — new app
- Magic-link login (`/login/:slug`), `/account/:token` (service status + invoices
  + Pay). Backend reuses the S502 token system.
- **Web Push** (Nic: "push notifications in the portal, no sms/email"):
  `customer_push_subscriptions` + `services/customerPush.ts` (web-push, VAPID via
  env with a DEV FALLBACK pair so no .env edit; prunes expired subs);
  `GET /public/push-key` + `POST /public/customer/:token/push-subscribe`. Fired on
  arrival→"you're next" (NEXT stop's customer), completion, skip, + backstop cron.
  Frontend: `public/sw.js`, `lib/push.ts`, AccountPage "Enable alerts" + 30s poll.
  Customer messaging is push-on-final-outcome + pull-in-portal — a skip can't send
  a contradictory "you're next" then "skipped".

### Per-unit service time + efficiency (3 chunks)
- `businesses.service_seconds_per_unit` (owner rate) × `business_customers.unit_count`
  = each stop's service time, snapshotted as `route_stops.expected_seconds` through
  generation/insert/reorder/eta. Office route detail shows "On site 12m · expected
  10m · +2m" per stop. Owner Settings card (rate + unit label) via PATCH
  /businesses/me; per-customer Units field on CustomersPage add/edit.

## Migrations applied (3)
- `20260621120000_route_gps_arrival_and_eta.sql` (dwell/geofence cols — geofence now
  dormant; `route_stops.projected_eta`; `generated_routes.last_lat/lon/position_at`)
- `20260621130000_customer_push_subscriptions.sql`
- `20260621140000_per_unit_service_time.sql` (service_seconds_per_unit,
  service_unit_label, business_customers.unit_count, route_stops.expected_seconds)

## New files
API: `services/{routeInsert,routeReorder,routeEta,routeDirections,customerPush}.ts`
(+ their `.test.ts` where applicable), `jobs/routeAutoAdvance.ts` (rewritten).
Business: `components/RouteMapLive.tsx`. Customer app: whole `apps/customer/**`
incl. `public/sw.js`, `src/lib/push.ts`. New deps: `maplibre-gl` (business),
`web-push` + `@types/web-push` (api).

## Recon corrections to past handoffs (verified against code)
- The owner "share customer portal link" button ALREADY EXISTS (S502 CustomersPage
  `onPortalLink`/`onRevokePortal` + `POST /business-customers/:id/portal-link`).
  S509 handoff was wrong to list it as TODO.

## Remaining / next session
- **Launch infra cluster (do together):** self-host **Nominatim** (`GEOCODER_URL`),
  **map tiles** (`VITE_MAP_STYLE_URL`), **OSRM** (`OSRM_URL`); set real **VAPID_
  PUBLIC_KEY/VAPID_PRIVATE_KEY**; serve the customer portal over **HTTPS** (Web Push
  + geolocation both need a secure context). All env-swappable; dev uses public demos.
- **Perf:** lazy-load the DriverPage route (MapLibre adds ~380kb gz to the business
  bundle).
- **Native driver app** for true zero-tap background GPS (future, the only way to
  get app-style nav + automatic arrival without the driver keeping GAM foreground).
- Customer app polish: `/invoice-paid` return route (Stripe successUrl currently
  falls through to the landing redirect).
- Other walkthrough clusters still open: Fitness (6), remaining Business #2–11
  (calendar sync, hosted booking site, deposits, etc.), Landlord Reports/Lease/
  Schedule, Marketing (LAST). Several Landlord/Tenant/Admin items from S508 remain.

## How to resume
- `~/gam-start.sh` boots everything incl. Customer app (:3014). dev.sh has the
  business + fitness preview entries in `.claude/launch.json`.
- Demo: Business `owner@business.dev`/`business1234` (Acme Hauling). Generate a
  route on :3012 → Routes → Truck 1; open Driver view to see the map (GPS won't
  fire on desktop — arrival/departure are device-GPS driven).
- Customer portal: `:3014/login/<business-slug>` (check
  `SELECT public_booking_slug FROM businesses WHERE name='Acme Hauling'`); magic-
  link emails need a real RESEND_API_KEY, so in dev mint a token and hit
  `:3014/account/<token>`.
- Tests: `cd apps/api && npx vitest run src/jobs/routeAutoAdvance.test.ts
  src/services/route*.test.ts src/routes/publicCustomerPortal.test.ts` (29 green).
