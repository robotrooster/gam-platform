# SESSION 606 HANDOFF — Oak Park unblocked (Connect KYC DONE); portal lockout fixed; deploy automation; sublease + lot-rent shelved

> Opened with the first ORGANIC signup and ended with **Oak Park's Stripe Connect
> verification complete** — the launch gate that had been open since S559 is
> closed. In between: a real lockout bug that cost Nic two days, a one-command
> deploy tool, the PM portal launched, and two half-built workflows shelved.
>
> **7 migrations applied to `gam` (LIVE). API restarted ~20×. landlord / admin /
> tenant / marketing / NEW pm-company all deployed. Nothing committed.**

---

## ✅ THE HARD GATE IS CLOSED — Oak Park can take rent

`acct_1U5VpMDz9hhZGjwY` · details_submitted ✅ · charges ✅ · payouts ✅ ·
payout bank **PNC ••9677** (verified, default for USD).

**Remaining Oak Park work is Nic's data entry**, not code:
- 19 RV spots exist, **0 tenants, 0 leases**
- 19 electric submeters exist and are unit-linked, **0 readings**
- Water RUBS not configured (no water meter yet)
- **Aug 31 deadline:** backdated BASELINE reads must be entered BEFORE the Aug 31
  reads, or the first cycle bills NOTHING and says nothing (engine returns
  "no prior reading — first cycle baseline" silently).
- When sending the 19 leases: **tick "Security deposit is already held"** (~$6,650).
- Unit `security_deposit` is 0.00 on all 19 — cosmetic, but it pre-fills leases wrong.

---

## 1. ⭐ THE LOCKOUT — four bugs, two days lost

Nic could not sign back into the real Oak Park account. Root causes, all fixed:

1. **Marketing had ZERO sign-in affordance.** Five "Get started" CTAs → `/register`.
   A returning landlord had no way back to a login page from our own homepage.
2. **`goldassetmanagement.com/landlord` returned 200 serving the MARKETING PAGE.**
   `apps/marketing/server.js` falls back to index.html for unknown paths, so a
   wrong URL looks like "nothing loads" rather than erroring.
3. **No password recovery in the landlord portal at all** — no link, no page, no
   route, while the API endpoint had existed since S289.
4. **`RESET_PASSWORD_URL` unset in prod** → every reset email would have carried
   `http://localhost:3002/reset-password`.

**Fixed:** `Sign in` nav link + `gamSignIn()`; 302 redirects for
`/landlord` `/login` `/signin` `/register` `/tenant`; landlord ForgotPassword +
ResetPassword pages; the API now derives the reset link from the request
**Origin**, allow-listed against known portal subdomains (landlord, tenant,
admin, pm, business, pos) so a spoofed Origin can never receive a token.
**Also fixed the same recovery gap on business + pm-company.**

### The 401 interceptor (the reason it was invisible)
Every portal auto-logged-out on 401 by doing `window.location.href = '/login'`.
On a FAILED SIGN-IN that's a reload — the form clears and the error message is
destroyed, so a wrong password looked identical to a broken app, and identical to
"2FA never sent me a code" (the password check runs BEFORE any code is issued).
Tenant had the `/auth/` carve-out since S537; **landlord, business and pm-company
did not. All four now do.** See memory `gam-401-interceptor-auth-carveout`.

### Stale-shell self-heal
A page that had stopped talking to the server, curable only by ⌘⇧R. Root cause
never proven (old bundles still resolve, no service worker, CORS fine), so
`packages/shared/src/versionWatch.ts` fixes the CLASS: compares the running
bundle hash to the deployed one. **bfcache restore + mismatch → auto-reload;
refocus / 5-min poll → banner only** (never yank a page mid-data-entry).
Wired into landlord, tenant, admin. Verified end-to-end.

---

## 2. ⭐ `bash deploy.sh` — USE THIS, DO NOT DEPLOY BY HAND

Nic: *"we should be doing that automatically... that way we're not working on old
visuals."* One command builds shared → API → marketing → every Vercel frontend,
deploys **only what differs from what prod actually serves**, and verifies each
against the live domain. `--check` reports only; `--all` forces.

**Why not git-auto-deploy:** Vercel's remote build 404s on `@gam/shared`, so
frontends must be built locally and shipped `--prebuilt`.
**The one everyone forgets:** marketing has NO build step — `server.js` reads
`index.html` once at startup, so a `launchctl kickstart` IS the deploy.

---

## 3. ⭐ FIRST ORGANIC SIGNUP + the outreach machine

**Charlie Moore** (`charlie.moore69@mx-mailsrv.com`), 2026-08-15 05:46 — 52-second
session, bounced off the onboarding wizard, never returned. Two emails sent from
`support@` (both **delivered**, zero engagement, never logged in).

Built and LIVE:
- **`jobs/landlordWelcomeOutreach.ts`** — organic signups get a personal
  onboarding-call email ~90 min later, 8am–7pm Phoenix **send window** (out-of-
  window work is HELD, not dropped). Deliberately plain: no branding, no CTA
  button, no images, support sender. The delay IS the feature — never move it
  into the signup handler.
- **Token-prefilled booking link** `goldassetmanagement.com/#onboarding/<token>` —
  identity comes from the TOKEN ROW ONLY (body name/email ignored); token rides
  the URL **fragment** so it stays out of logs and Referer headers.
- **Resend delivery webhook** (`/webhooks/resend`, Svix-verified, fails closed) +
  first-party **click tracking** on the prefill endpoint. Deliberately NO open
  pixel — Apple Mail pre-fetches images, so opens lie in both directions.
- **Admin → Signup Outreach** shows delivered / clicked / booked per landlord.

---

## 4. ⭐ PM-COMPANY PORTAL LAUNCHED — `pm.goldassetmanagement.com`

Nic: *"if a landlord decides they want a property manager to run their thing, the
property manager can't even sign up."* Three things would have shipped broken and
were caught: **no `.env.production` at all**; a missing
`VITE_STRIPE_PUBLISHABLE_KEY` read as `(import.meta as any).env?.…` (a plain
`import.meta.env.VITE_` grep MISSES it — the S600 bug shape); and **no
`vercel.json`**, so the generated config 404'd everything except `/` — `/register`
would have been dead. Sequence that works is in memory `gam-vercel-deploy-prebuilt`.

---

## 4b. ⭐ BANK FEED — APPROVED, LIVE, AND WIRED INTO ONBOARDING

Stripe approved Financial Connections mid-session. Verified working end to end on
the real Oak Park account: **PNC Bank ••9677 linked, 112 transactions imported**
back to 2026-02-19. Link remembered the account from the payout setup, so it was
just a texted code — Nic: *"a lot less painful than I thought."*

**Selected on the FC application** (all verified against what the code uses):
data types `payment_method` + `transactions` only — NOT balances, NOT ownership.
Use case: money movement + financial management. **Explicitly NOT
"underwriting or creditworthiness"** — that would contradict GAM's not-a-lender
posture across the Flex Suite. US-only storage agreed (true: DB is on the Mac in
Arizona) — **any future managed-DB migration must be a US region.**
`legal/INFORMATION_SECURITY_PROGRAM.md` was written for the security attestation;
it includes an honest "Known limitations" section (no SOC 2/ISO, single operator,
self-hosted, no pen test).

**Three fixes it needed immediately:**
- **First sync looked broken.** Stripe replies "a transaction refresh is still
  pending" while backfilling a new account — normal, but it was written as
  `status='error'` with the raw message, so a just-connected bank sat in an error
  state. Now treated as a normal pending first sync.
- **Nothing retried.** The sync at link time returns empty by design and no job
  ever tried again — the landlord would have had to keep pressing Sync. Added
  `syncAllActiveConnections()` + an hourly cron; one landlord's failure can't
  block others.
- **Books start date** (`landlords.books_start_date`). Linking pulls the bank's
  whole history — Oak Park's queue was 112 rows back to February. Anything before
  the date is imported but auto-`ignored`. **Retroactive and reversible both
  ways** (tested: →Jul 1 restored 22, →Aug 1 hid them again). **Already-
  categorized rows are NEVER touched** — silently un-booking a real expense
  because a date moved would change the landlord's financials behind their back.
  Oak Park is set to 2026-08-01: queue went 112 → 14.

**Onboarding is now 5 steps** (Nic's directive — the feed is NOT optional):
Business Profile → First Property → **Get Paid** → **Connect Your Bank** →
Sign Agreement. Continue is disabled on step 4 until a bank is actually linked.
This could NOT have shipped before approval — a required step on a button
returning 503 would have trapped every new signup.

Transaction amounts are now labelled **"money in" / "money out"**; colour alone
(green vs white) wasn't self-explanatory.

---

## 5. Other builds this session

- **Retire & replace units** — enforced by DB TRIGGERS, not by auditing ~120
  files. Widened the S604 owner_use lease trigger + added a booking trigger;
  "never billed" then falls out for free. Only pickers needed filters. Clone uses
  an explicit column list with a **drift test** that fails when a new `units`
  column isn't classified. See memory `gam-unit-retire-replace`.
- **Deposit-interest admin surface** (super-admin) — pool spread + 50-state
  catalog. Rate display is basis-aware; caught FL (5% flat OR 75% of actual) and
  NY/PA (actual − 1% admin) being misread.
  ⚠️ **IL and NM are `index_linked` sitting at 0.0000 → the engine computes $0
  owed in two states that genuinely owe interest.** Harmless today (no landlord
  there), a live landmine the moment one signs up.
- **Platform health on Scaling Readiness** — Cloudflare tunnel / Stripe / Resend /
  Vercel / email deliverability / DB / nightly backup, each with an "Open console"
  link, plus a 15-min cron alerting on TRANSITION into trouble. It caught a real
  bug within a minute: a nightly cron emailing seeded demo data
  (`rita.recurring@example.com`). RFC 2606 reserved domains are now suppressed.
- **p95 latency tracker fixed** — was swinging 25↔465ms and flipping the panel to
  "Move". No minimum sample (p95 of 17 samples IS the slowest request), and it
  counted vendor-bound routes including the health panel itself. Now 200-sample
  minimum + vendor routes excluded.
- **Connect KYC clarity** — dashboard blocker banner, honest "Verify your business
  & get paid" copy with a have-these-ready list, and Stripe's raw requirement
  codes humanised (`CONNECT_REQUIREMENT_LABEL` in shared).
- **Bank Feed + Bank Reconciliation merged into ONE "Bank" tab**; old paths
  redirect. "Banking" renamed **"Disbursement Account"** (couldn't be
  "Disbursements" — that name is the payout list).
- **Dashboard "Next Disbursement" KPI now clickable** + "View all →" on the
  Recent Disbursements panel.

---

## 6. ⭐ SHELVED THIS SESSION — subleasing AND lot rent (one flag)

`system_features.subleasing_enabled = FALSE` governs **both**.

- **Subleases:** routes/subleases.ts requires the sublessee to ALREADY be a GAM
  tenant. Nic: *"I know people that sublease in a variety of parks, they will
  never be able to use this until all the landlords are on the same software."*
  Nav was already hidden (S512) but `/api/subleases` was still MOUNTED and
  accepting writes, and the property page still captured a subleasing policy.
- **Lot Rent & Net:** folded in at Nic's direction — same business case (own homes
  in someone else's park, pay ground rent, rent to tenants), and unusable because
  the park isn't on GAM so every figure is hand-entered. *"It's not worth having."*

**Blocked:** sublease creation, invitation-accept, lot-rent accrual cron, and the
UI capture (subleasing policy + land-ownership checkbox + Lot Rent nav).
**Still open:** reads and terminations — nothing can be stranded.
**Dormant, not deleted** (OTP posture). Zero rows existed in either.

---

## 7. Bugs found and fixed along the way

- **Reset-link allow-list** used env vars that don't exist (`PM_APP_URL`,
  `BUSINESS_APP_URL`) → PM/business resets would have landed on the TENANT app.
- **`bankReady` on the dashboard** checked the legacy bank catalog, so a landlord
  who finished Stripe was still told "Add a bank account". Now checks
  `connect_payouts_enabled`.
- **Properties-page "Bank account setup incomplete" banner** queried the
  USER-level Connect account, but S554 re-anchored owner accounts to the
  **LANDLORD** entity — so it nagged a fully-verified landlord forever.
- **Lot Rent nav gate disagreed with the feature** — nav tested for a
  `mobile_home` unit; the feature accrues on `operator_owns_land = FALSE` with no
  unit-type restriction. An operator with lot rent on any other unit type would
  have had charges accruing they could never see. (Now moot — shelved.)
- **`cleanupAllSchema`** now clears `audit_log` before `users`.
- **BankFeedPage read `data.message`** on every error, but the API's shape is
  `{ success:false, error }` — so it was ALWAYS undefined and every failure
  degraded to axios's raw "Request failed with status code 400", hiding what
  Stripe actually said. Classic wire-contract mismatch; 3 call sites fixed.

---

## 8. MIGRATIONS APPLIED (to `gam`, LIVE) — 7
`20260815100000` landlord welcome outreach (+ backfill-as-sent) ·
`20260815110000` onboarding booking tokens + onboarding availability ·
`20260815120000` unit retire & replace (columns + widened lease trigger + booking trigger) ·
`20260817100000` email delivery events (provider_message_id / last_event) + booking-link clicks ·
`20260817110000` shelve subleasing ·
`20260817120000` fold lot rent into the sublease shelf ·
`20260817130000` books start date (bank-feed cutoff)

---

## 9. ▶ NEXT

**Nic (nothing here is code-blocked):**
0. **Nic: re-link PNC once.** Bank → Disconnect, then Connect a bank again.
   This is the only remaining manual step from the balance + income work below.
   Reason: balance and income are BUILT and live, but Oak Park's existing PNC
   link was consented for transactions only, so its balance reads "needs a quick
   re-link" until it's re-consented. Re-importing is safe — a duplicate guard
   was added (same landlord + institution + last4 → same-day/amount/description
   rows are recognized as already imported), so the 112 transactions and the
   Aug 1 books-start cutoff survive the re-link intact.

   Background: `balances` was left off the FC application on my advice ("nothing
   reads balances"), which was true of the code and wrong about the product —
   Nic asked for a balance an hour later. It turned out Stripe had ALREADY
   approved `balances` alongside `transactions`, so no application edit was
   needed; the only gap was the per-link consent.
1. Oak Park tenants + leases (deposit-already-held box on all 19)
2. **Baseline meter reads before Aug 31** — the only hard deadline
3. Water RUBS on the utilities page

**Claude, unblocked:**
1. **IL/NM index values** (§5) — real correctness gap, not "annual refresh"
2. **Marketing telemetry** — `portal='marketing'` has NEVER recorded a row, so no
   signup has acquisition attribution
3. **Register-form phone validation** — `z.string().optional()`, accepted an
   undialable number from our first real customer
4. Wire `<VersionWatch/>` into business + pm-company; deploy their 401 +
   recovery fixes (neither is Vercel-linked yet)
5. Dormant `/initiate-rent-collection` route claims a scheduler calls it — nothing
   does, and it was gated on the legacy bank catalog. Clean up before someone
   switches it on.
6. Rest of `ONBOARDING_PUNCHLIST.md` (~13): multi-LLC signup **(punchlist calls it
   "common, not an edge case")**, bank step after units, RUBS at onboarding,
   opening-read prompt, carried tenant balance, physical/mailing address,
   property-type multi-select, land-on-add-unit
7. Agent sweep cluster #6 (27 articles, BY HAND, no fan-out) — untouched
8. Snowbird 2b, add-and-pay frontend, seasonal pricing — untouched

**Blocked on a Nic DECISION:** bank step before units exist (the wizard has NO
unit step — needs a units step + fee quote, or make banking deferrable).

## QUICK-REF
- **Deploy everything:** `bash ~/gam/deploy.sh` (`--check` to dry-run)
- Restart API only: `cd apps/api && npm run build && launchctl kickstart -k gui/$(id -u)/com.gam.api`
- Tests: `cd apps/api && DB_NAME=gam_test npx vitest run <file>` (NEVER without `DB_NAME=gam_test`)
- Health: admin → Scaling Readiness · Outreach: admin → Signup Outreach
