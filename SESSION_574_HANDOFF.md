# SESSION 574 HANDOFF

**Theme:** Landlord-portal walkthrough — mandatory email-2FA, POS cashier passcode / terminal lock, per-property websites LIVE on `*.gam.biz`, and a landlord UX polish batch. Long session; everything below is on disk, typecheck-clean, and (backend) live in the running API.

---

## SHIPPED (built + tested + typecheck-clean; API rebuilt & restarted, so all backend is LIVE)

### 1. Mandatory email-2FA — landlord + business_owner (email-only, no authenticator)
- `UNIVERSAL_EMAIL_2FA_ROLES = {tenant, landlord, business_owner}` in `auth.ts`. Every login emails a 6-digit code; flag canonicalized on first sign-in + backfilled by migration.
- Landlord & POS portals expose **no** TOTP enrollment. Landlord: removed `TotpEnrollPage` (deleted), its route, and the "enable 2FA" nudge; `SettingsPage` shows a read-only "On — email code". POS + landlord `LoginPage`/`AuthContext` gained the **email-OTP step** (POS previously assumed a full token → any 2FA account broke login — fixed).
- Legacy `totp_enabled` accounts still verify via the dormant TOTP branch; no new account can enroll.
- Signup auto-logs-in once; 2FA fires on the NEXT login (same as tenants — Nic OK).
- Business/POS signup (`POST /businesses`) now **emails a verification link at signup** like `/auth/register` (was a gap — spam accounts slipped through the first session).

### 2. POS cashier passcode + terminal lock screen (business_staff only)
- Owner (full email+2FA session) taps **"Hand off to cashiers"** → mints a `pos_terminal` token (purpose-scoped; rejected by `requireAuth` everywhere except `/pos-lock/unlock`) + drops the full session → **lock screen**. Cashier enters a **4–6 digit passcode** → `/pos-lock/unlock` → a `posLimited` cashier session (no purpose, so `requireAuth` accepts it; a central `requireAuth` guard restricts it to the register surface via `isPosLimitedRequestAllowed`). Cashier can ring + take payment + **refund (gated by `pos.refund`)** — reports/settings/banking all 403.
- Owner sets per-staff passcode (bcrypt, unique-per-business) on the POS **Team** page (`PUT /business-users/:id/passcode`).
- Landlord portal deliberately has **NO passcode** — front desk just logs into the POS with credentials (Nic's call).

### 3. Per-property websites LIVE on `*.gam.biz`
- **Cloudflare (Nic did in dashboard):** activated Zero Trust Free; added a **Published-application-route** `*.gam.biz → HTTP localhost:3015`; created a **manual proxied CNAME `* → e7a31d39-a03f-4fcd-9782-37e575dc464e.cfargotunnel.com`** in the gam.biz DNS zone (wildcards don't auto-create DNS). TLS = Cloudflare Universal SSL. Tunnel = token-managed "Gam API" (account `ede70faef794ae5925b601660d662f4e`).
- **Storefront is now a PROD service:** `apps/storefront/server.js` (static SPA server, any Host) run by launchd `com.gam.storefront` (:3015, KeepAlive), mirroring marketing. `start-launch-set.sh` kickstarts it (removed the dev-vite line).
- **Auto-publish on onboard:** creating a property (`properties.ts`) auto-assigns a slug + `public_booking_enabled=TRUE`. Slug DEFAULT flipped to **name + street number** ("oak-park-22658", was name-city) in `propertyBookingAdmin.ts`.
- Landlord "Website" link per property card (PropertiesPage). API URL + slug URL are **runtime-derived** by `location.hostname` (no build env). `allowedHosts:['.gam.biz']` in storefront vite.config.
- **VERIFIED end-to-end in browser:** `https://sunset-palms.gam.biz` renders live property data over HTTPS.

### 4. Landlord UX batch (frontend, Vite-live; NOT browser-verified — 2FA gates auto-login, Nic to eyeball)
- **Disbursements:** removed the auto-Friday banner + entire Withdraw Now flow (button + modal + dead code). Balance cards reframed "Pays out on the next Friday batch" / "Link your bank to get paid."
- **Master Schedule guest-name:** z-index fix (label cells → `zIndex 2`, below sticky Unit col at 3, above bars at 1 — kills the "see-through/blank" long-stay bug) + name repeats every **21** days. (Interim — see queue #1.)
- **Dashboard KPI:** new **Platform Fee · Referral Earnings · Net** trio (3 separate cards, NOT netted). Referral from `GET /landlords/referral-earnings.thisMonth`.

---

## DECISIONS MADE
- 2FA: email-only, mandatory, no authenticator app anywhere for these roles.
- Cashier passcode limited to transactions (ring/pay/refund-if-perm); owners need 2FA to see reports/sensitive data.
- Email verification: fix the POS/business path to match (verify-after-create), not verify-before-create.
- Domain: **`{slug}.gam.biz` subdomain** (not `goldassetmanagement.com/{slug}`) — architecture already assumes it, security isolation of public vs authed, "their own site" feel + future custom domains.
- Nav consolidation: **sub-tab the obvious clusters, NO accordions** ("looks tacky").
- Disbursements: remove the whole banner + Withdraw Now entirely.
- KPI Fee/Referral/Net: three separate cards, don't net.
- Schedule name: FLOATING aligned-column name is the target; 21-day repeat is interim.
- Referral vanity codes: DEFERRED (decide later).
- Volume discounts: NOT doing (Nic thinking out loud).
- Platform merch store: DEFERRED post-launch, NOT stubbed (see memory `gam-platform-merch-store-deferred`); landlord merch is a separate later thing.

---

## TESTS / STATE
- API suites green across everything touched: `posLock.test` (13), `auth.test` (35), `authBusiness.test` (11), `emailOtp.test` (9), `businesses.test` (43), `businessUsers.test` (32), `properties.test` (37), `propertyBookingAdmin.test` (10). (Focused runs per the test-scope rule.)
- Typecheck clean: apps/api, apps/landlord, apps/pos, apps/storefront.
- Migrations applied (3): `20260731090000_universal_landlord_email_2fa`, `...093000_universal_business_owner_email_2fa`, `...100000_business_staff_pos_passcode`.
- Services: API `:4000` (rebuilt + kickstarted, all new code live), storefront `:3015` (prod service).

---

## FILES TOUCHED (major)
- **api:** `routes/auth.ts`, `routes/businesses.ts`, `routes/businessUsers.ts`, `routes/posLock.ts` (new), `lib/posLock.ts` (new), `routes/posLock.test.ts` (new), `routes/properties.ts`, `routes/propertyBookingAdmin.ts`, `middleware/auth.ts`, `index.ts`, 3 migrations, edited tests (auth/authBusiness/properties/propertyBookingAdmin).
- **landlord:** `LoginPage`, `AuthContext`, `SettingsPage`, `main.tsx`, `Layout.tsx`, `PropertiesPage`, `SchedulePage`, `DisbursementsPage`, `DashboardPage`; deleted `TotpEnrollPage`.
- **pos:** `LoginPage`, `AuthContext`, `TeamPage`, `LockScreen.tsx` (new), `main.tsx`.
- **storefront:** `main.tsx`, `vite.config.ts`, `server.js` (new).
- **root/deploy:** `deploy/launchd/com.gam.storefront.plist` (new), `start-launch-set.sh`.

---

## NEXT SESSION — QUEUE (all recorded in memory `gam-s574-landlord-ux-queue`)
Nic's suggested order: **#2 receipt upload first (self-contained), then #4 nav.**
1. **Master Schedule FLOATING name** (supersedes the 21-day repeat): one name per reservation, pinned/sticky to the visible left edge so a full park's names line up in a COLUMN. Needs a per-reservation sticky overlay (per-cell `<td>` labels can't sticky across a span). Verify visually.
2. **Manual-expense receipt UPLOAD** — receipt file on a manual property/unit expense (not via bank rec), stored for tax logging. (ExpensesPage + landlord_expenses + multer route; mirror the property-site-photos storage pattern.)
3. **Lot Rent & Net nav tab → conditional on mobile-home units** (flag on `/auth/me` + gate in `visibleNavItemsFor`).
4. **Nav sub-tab consolidation** — fold Screening (3) + Financials (10) into single top-level items with sub-tab pages; no accordions. ~34 nav items don't fit one screen; landlords are desktop-first.

Also open (not landlord-UX): storefront prod TODO (captcha/rate-limit, landlord inquiry inbox); move the Cloudflare account off Nic's personal card to the business card.

### Parked idea — referral vanity codes (DECIDE LATER, captured so it's not lost)
- **Today:** a landlord's referral code is system-generated, **not settable** — an 8-char code derived from their user UUID (e.g. `L3F2A9B1`), uppercased, unique (`users.referral_code`), minted lazily on first `/landlords/my-referral` request.
- **Proposal (recommended):** let them set a **custom vanity code** (e.g. `REALESTATERHOADES`) with the random one as the default fallback. Guardrails: uppercase-normalize, 4–20 alphanumeric, uniqueness check, reserved/profanity block. Length only matters for the random fallback.
- **Mechanic to remember:** a referral fires on a landlord **signup**, NOT on adding a property. So a landlord adding a 2nd property to the *same* account earns nothing; they'd only earn the closer residual (25¢/occupied unit/mo) if the other property is a **separate landlord signup** using their code (effectively self-referral via a second account). Nic explored using this as a bulk-discount workaround for multi-property landlords → rejected (account fragmentation + distorts sales-comp pool). Volume discounts also decided OFF for now. So referral stays for genuine landlord→other-landlord growth.

---

## VERIFICATION TODO FOR NIC (live portal — you get the 2FA code by email)
Eyeball on the running landlord portal: Disbursements page (banner/Withdraw Now gone), Master Schedule long-stay names (readable, not see-through), Dashboard Fee/Referral/Net trio. Onboard a test property and confirm it goes live at `{name}-{street#}.gam.biz`.
