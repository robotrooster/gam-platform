# SESSION 599 HANDOFF — property booking agent (Skye) on subdomains, booking-site editor, GAM Books deployed, Vercel prebuilt-deploy discovery, Properties card polish

> Huge multi-thread session. **Almost everything is DEPLOYED LIVE** (see each
> section). The working tree was **committed + pushed mid-session** by Nic
> (`7dab597`, "S595–S602" bulk of all previously-uncommitted work) → then a few
> more landlord changes landed **uncommitted** (card/money fixes). Two migrations
> applied to `gam`. All 6 Vercel frontends redeployed.

---

## 1. Agent chat cadence propagation — DONE (tenant/landlord LIVE; guest shell committed, NOT restarted)
Ported Lucy's marketing "Read receipt → typing → paced reply bubbles" cadence into the other agent chat widgets. Timing constants: `readMs=min(4500,1100+len·40)`, +800ms→typing, per-bubble `typeMs=min(9000,max(1800,len·55))`, inter-bubble `readGap=min(5000,max(1400,len·18))`, reply split on blank lines.
- `apps/tenant/src/components/AgentChatWidget.tsx` (Ava/Samantha) + `apps/landlord/src/components/ChatWidget.tsx` (David/Sonny): React state machine (`indicator: 'none'|'read'|'typing'`), "…is looking into that" → "…is typing". **LIVE** (Vercel redeploy).
- Guest-stay shell `apps/marketing/server.js` `renderStayShell()` (`/stay/:token`, Skye): vanilla-JS port, id-based read/typing markers. **On disk + committed but marketing server NOT restarted** (Nic said hold). To go live: `launchctl kickstart -k gui/$(id -u)/com.gam.marketing`.

## 2. Property booking agent "Skye" (pre-booking, on the subdomains) — BUILT + LIVE + verified
The big feature. A **public, property-scoped, self-updating** agent on each `{slug}.gam.biz` booking site that answers pricing/availability/amenities for THAT property and can start a reservation. New audience `visitor` (distinct from `prospect`=Lucy sales, `guest`=post-booking stay).
- **Reused the existing engine** (`runAgentSession` audience-driven; every tool hard-scopes to `actor`). Same pattern as the booking-token guest agent, keyed on `propertyId`.
- Extracted the pricing/availability engine `typeAvailability` etc. out of `routes/publicPropertyBooking.ts` into **`services/propertyBookingQuote.ts`** (one source for the route AND the agent; +`listSiteTypePricing`, `resolvePropertyById`, added `booking_slug`/`booking_about`/`booking_area` to `PropertyRow`).
- **4 tools** (`services/agents/tools/`, all `audiences:['visitor']`, hard-locked to `actor.propertyId`): `getPropertyInfo`, `getPropertyPricing` (back-in vs pull-through live rates; weekly=the weekly discount), `checkPropertyAvailability` (dated quote via `typeAvailability`), `createBookingCheckout` (collects details once → `bookStay` → returns Stripe deposit checkout link).
- **`VISITOR_ENTRY` (Skye)** profile in `profiles.ts` (agentType 'booking', knowledgeScopes ['shared'], the 4 tools, honest-AI, brief). Wired: `AGENT_AUDIENCES` += 'visitor' (types.ts); `agentSession.ts` role guard + answer-cache DISABLED for visitor (no cross-property leak); `logInteraction.ts` null-userId guard + `resolveInteractionProperty` visitor branch.
- **Route** `POST /api/property/:slug/agent/chat` (`routes/agent.ts` `propertyAgentRouter`, mounted `/api/property` in `index.ts`): resolves slug→property (404 unless `public_booking_enabled`), sets `{role:'visitor', propertyId}` actor, IP-rate-limited, client-supplied history.
- **Migration** `20260810160000_agent_interaction_logs_visitor_audience.sql` (adds 'visitor' to the audience CHECK). Applied.
- **Widget** on the subdomain site `apps/storefront/src/main.tsx` (`PropertyChat`, floating, read→type cadence, per-property localStorage) → posts to the new endpoint. **LIVE** (com.gam.storefront restarted).
- **Verified LIVE** on `sunset-palms.gam.biz`: Skye answered "pull-through $65/night, back-in $48/night, weekly/monthly…" via `get_property_pricing`. Tests: `propertyAgentTools.test.ts` (9, incl. cross-property isolation) + `propertyAgentRoute.test.ts` (4) + booking flow (37) = 50 green. API rebuilt + `com.gam.api` restarted.

## 3. Pre-existing bug fixed: bookStay ignored site-type rates
`services/propertyBooking.ts` `quoteStay`/`resolveUnit` resolved rates **unit→property only**, but the availability quote resolves **subtype→unit→property**. A property priced at the SITE-TYPE level (how you'd price back-in vs pull-through) showed prices but **failed at checkout** ("No rate is configured") — broke the public booking form too. Fixed: `resolveUnit` LEFT JOINs `property_unit_subtypes`; `quoteStay` falls back subtype→unit→property. 37 booking tests still green.

## 4. Booking-site editor (discoverable) + personalization content — BUILT + LIVE
The editor existed but was a buried tab in Master Schedule. Now:
- **Dedicated `apps/landlord/src/pages/BookingSitePage.tsx`** + nav item **"Booking Site"** (Globe icon, `category:'booking_sites'`, route `/booking-sites` — repointed from its old redirect-to-schedule) in `Layout.tsx` + `main.tsx`. Full editor: publish+slug, welcome text, **Our story** + **The area & things to do** (NEW), photos, FAQs, rates, deposit/tax, office. Removed the SCHEDULE_TABS 'booking_page' tab (its bp* code + the `view==='booking_page'` block in `SchedulePage.tsx` are now **dormant dead code — safe to delete in a focused pass**).
- **Migration** `20260810170000_property_booking_about_area.sql`: `properties.booking_about` + `booking_area` (free text). Applied. Wired into `propertyBookingAdmin.ts` booking-config GET/PATCH, the public `GET /property/:slug` payload (`about`,`area`), the `get_property_info` agent tool, and rendered as "Our story" / "The area & things to do" sections on `apps/storefront` HomePage. **LIVE** (demo content set on sunset-palms to prove rendering — overwritable from the editor). Confirms Nic's guess: **amenities are auto-pulled** from the property's common_areas.

## 5. ⚠️ Vercel deploy method — CRITICAL, was misunderstood, now SOLVED (memory `gam-vercel-deploy-prebuilt`)
The frontends are **NOT git-auto-deploy and NOT remote-build**. A `git push` saves to GitHub only. `vercel --prod` (remote build) FAILS — Vercel installs the app folder in isolation and 404s on the unpublished workspace pkg `@gam/shared`. **The real method = PREBUILT UPLOAD of a LOCAL build:**
```
cd apps/<app> && npm run build                       # local; resolves @gam/shared + reads .env.production for prod URLs
rm -rf .vercel/output && mkdir -p .vercel/output/static && cp -R dist/. .vercel/output/static/
printf '%s' '{"version":3,"routes":[{"handle":"filesystem"},{"src":"/.*","dest":"/index.html"}]}' > .vercel/output/config.json
vercel deploy --prebuilt --prod --yes                # server build = 0ms
```
Prod URLs (`VITE_API_URL=https://api.goldassetmanagement.com`) come from the **local** `apps/<app>/.env.production` (gitignored; Vercel env only holds `VITE_STRIPE_PUBLISHABLE_KEY`). **All 6 frontends redeployed current this session**: landlord, tenant, admin, admin-ops, pos, books. CLI authed `nic-1258`, team `goldengoose`.

## 6. GAM Books = its own live product — DONE (feature was already built S592)
Nic's model: Books at launch is **landlord-login only (NO public signup, unlike POS)** + a landlord can invite a **bookkeeper** team member (email-link, sets own password) who is **read-only or read-write** and **books-only** (API scopes them to the Books app; they can't see leases/tenants). **All already built S592** — `bookkeeper` role + `bookkeeper_scopes` (access_level) + Team page invite (`POST /api/scopes/bookkeeper/invite`) + role→apps map `bookkeeper:['books']`. Only the **deploy** was missing:
- Created `apps/books/.env.production` (VITE_API_URL + VITE_ADMIN_APP_URL).
- `vercel link` → gam-books project; prebuilt-deployed current code.
- Domain **`books.goldassetmanagement.com`** LIVE (HTTP 200, valid SSL). Gotcha: `vercel domains add` attaches+issues cert but does NOT bind to a serving deployment (edge rejects SNI → 000 for ~25min); the fix was **`vercel alias set <prod-deployment-url> books.goldassetmanagement.com`**. Cloudflare DNS `CNAME books → cname.vercel-dns.com`, proxied=false (token in `apps/api/.env` covers both zones; goldassetmanagement.com zone `653dd268ea26bbb1ab6e6ea5d956262a`). **NOTE:** because it's a manual alias, future Books prod deploys may need a re-`alias set`.

## 7. Properties page card polish — DONE + LIVE (uncommitted)
- **Alignment fix** (`PropertiesPage.tsx`): a long name ("Sunset Palms RV Resort") was pushing that card's metrics down. Fixed: name area FIXED 2-line height + address forced to 1 line + `minWidth:0` flex plumbing → all cards' icon/metrics/occupancy align. The **Website button is now icon-only** (Globe, matching Edit) to stop it squeezing the name — Nic can revert to the "Website" label if wanted (alignment holds either way). Verified in an isolated HTML harness.
- **Money format** (new shared `apps/landlord/src/lib/format.ts`): `fmtCompact` ($18,400 / $248.6K / $1.24M) on the **narrow tiles** (per-property Revenue + top-summary Monthly Revenue/Max Potential); `fmtWhole` ($248,600, no cents) on the **dashboard KPI cards**; **tables kept exact** (with cents) via each page's local `fmt`. Nic's decision: "only the narrow ones" abbreviated. Output unit-checked.

## Git / deploy state
- Last commit/push: **`7dab597`** (Nic-initiated, "S595–S602", 73 files). Since then, **uncommitted but DEPLOYED to prod**: `PropertiesPage.tsx`, `DashboardPage.tsx`, new `apps/landlord/src/lib/format.ts` (+ gitignored `apps/books/.env.production`, `apps/books/.gitignore`). Committing again is **Nic's call**.
- Everything self-hosted (com.gam.api, com.gam.storefront) restarted after each change. com.gam.marketing NOT restarted (guest-shell cadence pending Nic).

## Open / next session
1. **MARKETING PAGE** — Nic wanted to work on this and we kept getting pulled away. It's the next thing. Live at goldassetmanagement.com (`apps/marketing/src/index.html` + server.js, self-hosted :3004). Known-pending: legal/attorney pass; more revisions.
2. **Finish-line sequence (Nic's words):** after marketing → upgrade Resend (off dev tier), upgrade Vercel (→ Pro), upgrade the AI agents → then **onboard Oak Park**. "We're at the finish line."
3. **Dead code:** delete the dormant booking_page bp* block in `SchedulePage.tsx` (state @~333-341 + queries/handlers @~466-568 + JSX @~1982-2163 + `AuthThumb`/`STOREFRONT_TEMPLATE`/`API_URL` if orphaned) — noUnusedLocals is on, so remove as one clean set.
4. **Guest-shell font CDN:** `renderStayShell()` in `apps/marketing/server.js` loads Google Fonts CDN (violates the self-hosted-fonts rule); self-host like the main site.
5. Guest-shell cadence: restart com.gam.marketing to make it live (Nic's call).
6. Still pending from S595/597: fitness `/register` 2FA exception + `/leaderboard` privacy (Nic decisions).
7. Optional: propagate the read→type cadence is DONE for tenant/landlord/guest; nothing left there.

## Deploy quick-ref
- API: `cd ~/gam/apps/api && npx tsc -b && launchctl kickstart -k gui/$(id -u)/com.gam.api`
- Storefront/Marketing (self-hosted): `launchctl kickstart -k gui/$(id -u)/com.gam.storefront` / `...com.gam.marketing`
- Vercel frontends (landlord/tenant/admin/admin-ops/pos/books): **prebuilt** flow in §5 (NEVER `vercel --prod`).
- Migrations: `npm run db:migrate`. Tests: **`DB_NAME=gam_test`** always.
