# SESSION 598 HANDOFF — email/DNS lock, S597 audit, wife's busy calendar, signup→CS routing, marketing cleanup, agent honesty + Lucy voice

> Long session, six threads. **Everything below is LIVE** (com.gam.api + com.gam.marketing
> restarted after each change) and **UNCOMMITTED** — the entire working tree (this + all
> prior sessions) is Nic's call to commit. One migration applied to `gam`.

---

## 1. Email / DNS deliverability — DONE

Kicked off by a 3 AM Google email = a **routine DMARC aggregate report** (benign; goldassetmanagement.com's DMARC record has `rua=mailto:nic@golddoor.io`). Ran the whole posture down and locked it. New memory: **[[gam-email-dns-posture]]** (has the full state).

- **goldassetmanagement.com** — already fully wired for Resend (root DKIM `resend._domainkey`, SPF+MX on the `send.` subdomain, DMARC `p=none`). The real report showed **all-pass, zero spoofing**. Prod `apps/api/.env` confirmed `EMAIL_FROM_NOREPLY=GAM Platform <noreply@goldassetmanagement.com>` (NOT the `onboarding@resend.dev` fallback). Nothing to fix.
- **gam.biz** — websites-only (storefronts), sends no mail. Was missing SPF + had a GoDaddy-created DMARC `p=quarantine` reporting to GoDaddy. **LOCKED via the Cloudflare API** (token `CLOUDFLARE_API_TOKEN` in `apps/api/.env`, zone `CLOUDFLARE_ZONE_GAMBIZ`): added root TXT `v=spf1 -all` + updated `_dmarc.gam.biz` → `v=DMARC1; p=reject; sp=reject; rua=mailto:nic@golddoor.io; fo=1`. Verified live at the authoritative NS + Google resolver.
- **golddoor.io** — NOT Nic's domain (his work inbox, not in his Cloudflare). GAM only receives there. Left alone.

---

## 2. S597 demo-booking audit (by-hand) — DONE, 1 fix

Combed the live-but-uncommitted S597 code. **Verdict: solid.** Verified: double-booking guard real (`sales_call_slots.status DEFAULT 'booked'` + partial unique index), ICS injection clean (`escapeIcsText` on every prospect field), feed enumeration-safe (`timingSafeEqual`), admin routes role-gated (`admin`/`super_admin`), rate limiting effective (`trust proxy: 1`).

- **Fixed:** prospect first-name interpolated **unescaped** into 3 emails (`sendSalesCallConfirmation`, `sendSalesCallReminder`, `sendDemoBookingConfirmation` in `email.ts`) — self-XSS only, wrapped all in `escapeHtml`.
- Minor open note: no transaction around the lead-upsert + slot-insert in `bookSalesCall` → a rare double-book race could leave one orphan lead (self-heals; negligible). Not fixed.

---

## 3. Wife's "busy-only" sales calendar — BUILT + LIVE

A second, independently-revocable feed token so Nic's wife sees WHEN he's on a call but **no prospect data**.

- Migration `20260809140000_add_sales_busy_feed_token.sql` — added `sales_calendar_feed.busy_feed_token` (minted).
- `services/demoCalendar.ts` — `buildSalesFeedIcs(rows, now, scope)`; `scope='busy'` emits time-block-only events (`SUMMARY: "Busy — GAM Demo"`, no name/email/phone/brief/Jitsi link).
- `routes/publicSalesCalendar.ts` — matches the token to `feed_token` (full) or `busy_feed_token` (busy).
- `routes/admin.ts` `/demo-feed` — now also returns the busy token/urls.
- **Wife's link (delivered via Mac Messages + a QR):** `webcal://api.goldassetmanagement.com/api/public/sales-calendar/463bd5ae-632c-4fcd-a054-fe3b5ae94eb7.ics`. Nic's own full feed unchanged (`1cf5fcd9-…`).
- Also set `API_PUBLIC_URL=https://api.goldassetmanagement.com` in `apps/api/.env` (Nic-approved) so the admin feed URL is deterministic.
- **Nic declined** surfacing the busy link in the admin UI ("just a him-and-her thing").

---

## 4. Signup → sales-rep routing + CS 24h SLA (S595 §8) — BUILT + LIVE

**Big discovery:** the commission ENGINE already implements Nic's model (`jobs/commissionAccrual.ts`, S567/S592, monthly cron). Per occupied unit: closing 25¢ (→ closer, or **POT** if self-closed) + service/CS 25¢ (always a person via `landlords.service_manager_id`, never pot) + pot 10¢ always. **Organic close = 35¢ to pot** (25¢ orphan closing + 10¢ always) — verified by `commissionAccrual.test.ts` (10/10 pass). Full detail in memory **[[gam-signup-rep-commission-model]]**.

What was missing (and got built this session):
- **Signup alert** — `POST /api/auth/register` now fires best-effort/fire-and-forget: `admin_notifications` category `landlord_signup` + `sendLandlordSignupHeadsUp` email to `SALES_NOTIFY_EMAIL`. Organic (no closer) flagged "assign a CS rep within 24h" (`warn`). Hoisted `closerId`/`referredByUserId` in `auth.ts`; added `logger` + `sendLandlordSignupHeadsUp` imports; new email fn in `email.ts`.
- **24h CS SLA** — new `jobs/csAssignmentSla.ts` (hourly cron `20 * * * *` in `scheduler.ts`). Auto-assigns `service_manager_id = OWNER` for landlords whose CS needs a specialist (mirrors accrual's `closerDoesCs === false`) still unassigned >24h after signup. Idempotent; safe (accrual only reads `service_manager_id` when `closerDoesCs=false`, so a mis-assign can't misroute money). First run assigned the 4 existing self-closed accounts (all demo/internal) to Nic.
- **Nic's decision:** organic → auto-assign to HIM after 24h if unclaimed; keep the 24h window now so the future multi-rep claim/round-robin slots in ahead of the fallback. **NOT built (future):** the rep self-claim + round-robin.

---

## 5. Marketing page cleanup — DONE + LIVE (more revisions expected)

`apps/marketing/src/index.html` + `server.js`, deployed via `launchctl kickstart -k gui/$(id -u)/com.gam.marketing` (public site is `cf-cache-status: DYNAMIC`, not cached).

- **Fixed all 7 broken `localhost:3001/register` CTAs** → a `gamRegister()` helper reading injected `window.GAM_LANDLORD_URL`. `server.js` injects it (derives from the API host → `https://landlord.goldassetmanagement.com` in prod; localhost fallback in dev). **The landlord portal is deployed on Vercel at `landlord.goldassetmanagement.com` (`/register` returns 200).**
- **Removed the tenant-facing ACH "Payments" pricing card** (Nic: useless on a landlord page — landlords don't pay ACH). Pricing is now 2 centered cards (Platform / High volume); `.pricing-grid` → `repeat(2,1fr)` centered.
- "Trouble connecting" was **transient** — my own API restarts during the session + the slow self-hosted LLM (5–18s). Not a bug.

---

## 6. AI agents — honesty policy + Lucy's voice — DONE + LIVE

**Honesty (ALL agents, Nic directive).** They keep a warm/human tone, don't volunteer being AI, but **never claim to be human or deny it** — asked directly, they say "I'm GAM's AI assistant" + offer a real person. Changed `BASE_GUARDRAILS` (shared → tenant + landlord), `SALES_ENTRY` (Lucy), `GUEST_ENTRY` (Skye) in `profiles.ts`; **flipped** `agentEval.ts` `BOT_PROBE_FORBIDDEN` so a pose-as-human reply now FAILS. Memory **[[gam-agent-honesty-disclosure]]**. (This also killed a "repeated verbatim response" bug that was the old pose-as-human deflection.)

**Lucy's voice — the fix Nic pushed hard on.** After many failed rule-tweaks, **rewrote `SALES_ENTRY.systemPrompt` as an example-driven (few-shot) prompt** — this is what finally worked on the 36B model. She now replies in **1–2 sentences, one casual question at a time, natural, honest, and steers to a video call**. Battery-verified (94–193 chars vs the old 500–900). Qualifying-probe (state/units/mix/contact, one at a time) + `capture_lead` + `book_sales_call` all preserved.

**Marketing chat cadence** (`apps/marketing/src/index.html`, Lucy widget ONLY): visible "Read" marker (sized to the message), then typing, then reply; long replies **split into paragraph bubbles** each with its own typing beat + an inter-bubble read gap. localStorage persistence KEPT (real visitors shouldn't lose a convo). Tried+reverted a "New chat" button + TTL (Nic: a reset button is a robot tell).

**Isolation confirmed (Nic asked):** all Lucy brevity/voice/cadence work is Lucy-only — `SALES_ENTRY` is a standalone prompt; tenant (Ava/Samantha) + landlord (David/Sonny) use `composePrompt` (their role block + base) and were only touched by the shared honesty line. Cadence code is only in the marketing widget; tenant/landlord portals have their own chat widgets (`AgentChatWidget.tsx`, `ChatWidget.tsx`), untouched.

---

## Open / next session
1. **Lucy voice** — Nic is testing live; keep shaping if he finds rough spots. The example-driven approach is the lever (add/adjust example exchanges, don't add rules).
2. **Propagate the read→type cadence** to the guest-stay shell + tenant/landlord portal chat widgets if Nic wants the same feel (not done).
3. **Commission: rep self-claim + round-robin** for multiple reps (the claim layer slots ahead of the 24h owner-fallback). Build when a 2nd rep exists.
4. **Still pending from S595/S597** (untouched this session): fitness `/register` 2FA + `/leaderboard` privacy; marketing attorney/legal pass; more marketing revisions likely.
5. **gam.biz DMARC** is now `p=reject` (enforcing) — fine, non-sending domain. goldassetmanagement.com stays `p=none` (monitor); tighten later once launch volume confirms no other senders.
6. **Commit** — entire working tree uncommitted (this + prior). Nic's call.

## Deploy quick-ref
- API: `cd ~/gam/apps/api && npx tsc -b && launchctl kickstart -k gui/$(id -u)/com.gam.api` (prod runs `dist`; `.env` loads from cwd).
- Marketing: edit `apps/marketing/src/index.html` / `server.js` → `launchctl kickstart -k gui/$(id -u)/com.gam.marketing` (server reads `src/index.html` at startup).
- Migrations: `npm run db:migrate` from repo root (→ `gam`). Tests: **`DB_NAME=gam_test`** always.
- Self-hosted LLM (Lucy's brain): MLX on `localhost:8080` — slow (5–18s/reply); it's the ceiling on agent quality, not the prompt.
