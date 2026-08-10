# SESSION 597 HANDOFF — Demo booking LIVE + marketing go-live + self-hosted branded Jitsi

> Continues S596 (which was a mid-session "leaving for the night" checkpoint —
> now superseded/stale). This session: shipped demo booking to prod, deployed
> the marketing revisions, and stood up a fully self-hosted, GAM-branded Jitsi
> video server. Everything below is **LIVE**. All code is uncommitted (Nic
> decides commits).

---

## 1. Demo booking — BUILT + LIVE on goldassetmanagement.com

Marketing "Book a demo" → survey → pick a slot → onto Nic's calendar + a video
link. **Reused the S553 sales-call slot engine** (do NOT build a parallel
system — see memory [[gam-sales-demo-booking-engine]]) with a `kind`
discriminator (`demo` live; `onboarding` reserved).

**Decisions (Nic, this session):** window **Mon–Fri 1–4 PM America/Phoenix**;
six 30-min-cadence slots (1:00–3:30), each a **20-min** event (10-min gap);
**1-hour lead buffer**; once past the window start today → next day; **video =
self-hosted Jitsi**; **prospect sees their own local time**, mapped to the AZ
window.

**Files:**
- Migrations (applied to `gam` DB): `20260807120000_demo_booking_kind_and_meeting_url.sql`, `20260807120100_sales_calendar_feed_config.sql`, `20260808120000_add_prospect_timezone_to_slots.sql`
- `packages/shared/src/index.ts` — `SALES_BOOKING_KIND_VALUES`
- `apps/api/src/services/salesCalls.ts` — engine generalized by kind; 1h buffer, same-day cutoff, `groupSlotsByDay`, Jitsi room gen (`JITSI_BASE_URL`), prospect-tz formatting; `bookSalesCall` writes kind/meeting_url/survey/prospect_timezone + fires demo emails
- `apps/api/src/services/demoCalendar.ts` + `lib/ics.ts` — ICS builders (feed + prospect .ics)
- `apps/api/src/routes/agent.ts` — `GET /api/sales/demo/slots`, `POST /api/sales/demo` (dedicated rate limiter; server-side re-validation)
- `apps/api/src/routes/publicSalesCalendar.ts` — `GET /api/public/sales-calendar/:token.ics` (owner subscribe feed; enumeration-safe)
- `apps/api/src/services/email.ts` — `sendDemoBookingConfirmation` (.ics + Jitsi link, prospect-local time) + `sendDemoBookingHeadsUp` (to nic@golddoor.io, survey brief + prospect tz)
- `apps/api/src/routes/admin.ts` — call-slots list shows kind/survey; **kind-scoped** availability editor; `GET/POST /admin/demo-feed(/rotate)` — feed URL auto-derives from request host (no `.env` needed)
- `apps/admin/src/main.tsx` — Sales Leads page: subscribe-feed banner + Type column
- `apps/marketing/src/index.html` — the modal (survey → local-tz slot picker → confirmation); all "Book a demo" CTAs wired
- **Tests:** `salesCalls.test.ts` + `demoCalendar.test.ts` (17 pass, `DB_NAME=gam_test`)

**Nic's calendar subscribe:** DONE (subscribed on Mac + iPhone). Feed token in
`sales_calendar_feed`. Every booking also emails an instant heads-up to
nic@golddoor.io.

---

## 2. Marketing — DEPLOYED LIVE

- **`server.js` now injects `window.GAM_API_BASE`** from `API_URL` (=
  `https://api.goldassetmanagement.com`). The homepage previously couldn't reach
  the API cross-origin (marketing = goldassetmanagement.com, API =
  api.goldassetmanagement.com). **This also silently fixed Lucy's sales chat on
  the live site** (same latent bug).
- **Copy pass (Nic):** eyebrow "Property management for your entire portfolio",
  title "Run your entire operation from one platform", + de-RV'd the sub-headline,
  both reason blocks, `<title>`, footer. More revisions still expected.
- Deploy = `launchctl kickstart -k gui/$(id -u)/com.gam.marketing`.

---

## 3. Self-hosted Jitsi — LIVE + BRANDED at meet.goldassetmanagement.com

**Server:** DigitalOcean droplet `gam-jitsi-prod`, **146.190.145.126**, Ubuntu
24.04, 2 vCPU / 4 GB (~$24/mo, on Nic's DO account). SSH:
`ssh -i ~/.ssh/gam_jitsi root@146.190.145.126` (dedicated key, ed25519).
DNS: `meet` A-record → 146.190.145.126, **DNS-only (grey cloud)** in Cloudflare.

**Stack:** docker-jitsi-meet **stable-11146-1** at `/opt/jitsi`; config volume
`~/.jitsi-meet-cfg`; customizations in `/opt/jitsi/custom/` mounted via
`/opt/jitsi/docker-compose.override.yml`.

**TLS:** host **certbot standalone** (the in-container ACME was unreliable
behind the port setup). Cert at `/etc/letsencrypt/live/meet.goldassetmanagement.com/`
copied into `~/.jitsi-meet-cfg/web/keys/` (`ENABLE_LETSENCRYPT=0`). **Auto-renew
hooks** in `/etc/letsencrypt/renewal-hooks/{pre,deploy,post}/` (stop web → renew
on port 80 → copy cert → start web); certbot.timer active. Expires 2026-11-07,
auto-renews.

**Branding (all served-surface Jitsi removed → Gold Asset Management):**
in-call watermark (gold wordmark `custom/gam-watermark.svg`), tab title +
favicon + PWA manifest (`custom/title.html`, `custom/favicon.svg`,
`custom/manifest.json`), welcome-page lang strings (`custom/lang-main.json`),
`APP_NAME`, mobile-promo hidden (`custom/interface_config.js`). **P2P disabled**
(`ENABLE_P2P=false` → bridge-only, fixes freeze/kick).
**`no-store`** cache headers on lang/config/interface_config via `custom/meet.conf`
so branding edits always propagate (no cache staleness).
**Post-call:** hanging up lands on a branded **"Your meeting has ended"** page
(`custom/ended.html`, served at `/`) — no Jitsi, no auto-bounce, CTA to the site.

**HARD LIMIT (told Nic):** the compiled app bundle (`app.bundle.min.js`) contains
"jitsi" ~300× (the API is literally `JitsiMeetJS`). Those are invisible internals;
removing them = forking + rebuilding the whole project. Not done. Everything a
user sees is GAM.

**Firewall:** ufw REMOVED (it conflicts with Docker — caused a long debug). Clean
iptables INPUT rules via `/usr/local/sbin/gam-firewall.sh` + `gam-firewall.service`
(persistent, After=docker). Allows 22/80/443/10000+established/lo/icmp.

**Booking wiring:** `JITSI_BASE_URL=https://meet.goldassetmanagement.com` set in
`apps/api/.env`; every booking generates `meet.goldassetmanagement.com/gam-demo-<uuid>`.

---

## Open items / next session
1. **In-call notes (ASK NIC):** he takes notes during calls. The branded end
   page fixed the abrupt bounce. Clarify if he wants an in-call shared notepad
   (Jitsi Etherpad — needs an extra container) or just uses GAM admin Sales Leads
   in another tab.
2. **Stability re-test:** confirm P2P-off fixed the freeze/kick with a real
   2-person call.
3. **Nic's Safari cache:** one-time Empty Caches if his browser still shows old;
   `no-store` now prevents future staleness on any machine.
4. **Jitsi maintenance:** image pinned stable-11146-1. On any future Jitsi
   update, re-verify the `custom/` overrides still apply (templates can change).
5. **Signup → sales-rep routing** (S595 §8, still not started) — ties to the
   reserved `onboarding` booking kind (its own calendar window later).
6. **Commit:** entire working tree uncommitted (this + prior sessions). Nic's call.
7. Still-pending from S595: fitness `/register` 2FA + `/leaderboard` privacy;
   marketing attorney pass; more marketing revisions expected.

## Manage the Jitsi box (quick ref)
- SSH: `ssh -i ~/.ssh/gam_jitsi root@146.190.145.126`
- Restart web (after editing custom/*): `cd /opt/jitsi && docker compose restart web`
- Customizations: `/opt/jitsi/custom/*` mounted via `docker-compose.override.yml`
- Cert renews automatically; firewall persists via `gam-firewall.service`
