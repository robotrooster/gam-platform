# SESSION 605 HANDOFF — first organic signup; automated outreach + onboarding booking; retire & replace; deposit-interest admin surface

> Unplanned session. Opened with **GAM's first organic customer signup** and the
> question "who is this and how do I reach them", which turned into a full
> acquisition-response build. Second half worked the S604 punchlist unattended
> while Nic ran errands.
>
> **3 migrations applied to `gam` (LIVE). API rebuilt + restarted 5×. Marketing,
> landlord and admin all DEPLOYED to production. Nothing committed.**

---

## 1. ⭐ THE SIGNUP — Charlie Moore, 2026-08-15 05:46 Phoenix

`charlie.moore69@mx-mailsrv.com` · phone `6040606731` · organic, no referral code
· user `f0e4b651-…` · landlord `a56f4658-…`

**The whole session was 52 seconds.** Landed on the landlord app → `/login` →
`/register`, spent 34s on the form, registered 05:46:06, entered the 2FA code
correctly on the first try 16s later, hit `/onboarding` at 05:46:23 — and never
came back. Zero properties, zero units, no business name, no bank, no agreement.

**What we could NOT answer, and why it matters:** the register form collects only
name / email / phone / password / referral code. **No location, no unit count, no
property type.** The only geographic hint was area code 604 (Vancouver BC), and
`604-060-6731` is not a dialable NANP number (exchange can't start with 0). The
register form does no phone validation; the onboarding form does, but he never
got that far.

**Acquisition attribution is also blank:** `product_events` has never recorded a
single `portal='marketing'` row. The marketing site emits no telemetry at all, so
there is no referrer / campaign / landing page for any signup. **Open gap.**

**Why he almost certainly left:** `apps/landlord/src/main.tsx:126` redirects any
landlord with `onboarding_complete=false` to `/onboarding` and lets them reach
nothing else. The wizard demands business profile → a full property → **a
connected bank account** → **a signed platform agreement** before he can see one
screen of product. He hit that wall 16 seconds in.

Manual outreach sent 08:00 from `support@` (msg `28ab594d-…`), logged under
category `landlord_onboarding_outreach`.

---

## 2. ⭐ AUTOMATED POST-SIGNUP OUTREACH — LIVE

`jobs/landlordWelcomeOutreach.ts`, every 15 min, `scheduler.ts:1318`.

Every **organic** landlord signup gets a personal-feeling onboarding-call email
~90 min later, addressed by the first name they typed.

**Three design choices are the point — do not "optimise" them away:**
1. **The delay IS the feature.** Never move this into the signup handler. Instant
   = obviously automated, and it collides with the 2FA code they're waiting on.
2. **No `base()` branding, no CTA button, no images, no tracking.** Plain light
   HTML, system font. A gold-button dark template reads as marketing. Nic's brief
   was "feel like it's coming from a real person."
3. **SUPPORT sender, not noreply** — so "just reply" isn't a lie. support@
   forwards to Nic's golddoor.io.

Skips: rep-closed signups (`portfolio_manager_id`/`referred_by_user_id` — a rep
already owns that relationship), unverified email (bounces damage domain
reputation), demo/system landlords, anything >72h old (outage backstop).
Idempotency guard is `landlords.welcome_outreach_sent_at` — **deliberately NOT
`email_send_log`**, which is archived on a schedule and would let the check go
false and re-email people months later. Migration backfills every existing
landlord as already-sent so the first run can't blast the back catalogue.

**Send window, not "quiet hours"** (Nic corrected the naming mid-session):
`SEND_WINDOW_START_HOUR`..`END_HOUR` = 8am–7pm Phoenix is when sending IS
allowed. Out-of-window work is **held, not dropped** — a 2am signup goes out at
8am. Copy adapts on one sentence via `stalledInSetup` (no properties yet).

Env: `LANDLORD_OUTREACH_DELAY_MINUTES` (90), `LANDLORD_OUTREACH_HOUR_START/END`,
`LANDLORD_OUTREACH_MAX_AGE_HOURS` (72), `LANDLORD_OUTREACH_TOKEN_TTL_DAYS` (30).

---

## 3. ⭐ TOKEN-PREFILLED ONBOARDING-CALL BOOKING — LIVE

The email carries `goldassetmanagement.com/#onboarding/<token>`.

Opens the existing booking modal **relabelled "Book your onboarding call"** —
same slot engine, `kind='onboarding'` (30-min events, own Jitsi prefix) — with
identity prefilled, so a landlord who already has an account is never asked its
own name. Seeded `sales_call_availability` for `kind='onboarding'` Mon–Fri 1–4pm;
it had been a valid kind since S596 with **zero availability rows**, so nothing
could ever book one. Overlapping the demo block is safe: `listAvailableSlots`
excludes every booked start regardless of kind, and
`sales_call_slots_booked_start_uniq` enforces it at the DB. Test asserts it.

**Security shape (the load-bearing part):**
- Identity comes from the **token row only**. `POST /api/sales/onboarding`
  ignores any name/email in the body — there is a test that posts
  `attacker@evil.test` with a valid token and asserts the real landlord is
  recorded.
- Token rides the **URL fragment**, never a query string, so it stays out of
  access logs and Referer headers when the link is forwarded.
- **Not single-use** — reschedule from the same email must work. 30-day expiry is
  the bound; `used_at` is recorded but never gates redemption.
- Unknown / malformed / expired are indistinguishable (all 404), and the page
  falls **all the way back to the demo flow** rather than dead-ending.
- Bare `#onboarding` deliberately falls through to demo: booking onboarding
  REQUIRES a token, so onboarding labels without one would promise a booking the
  server can't make.

Also added `#demo` as a plain deep link (the modal previously opened on button
click only, so no link could be put in an email).

---

## 4. ⭐ RETIRE & REPLACE — built, deployed (S604's design, decided by Nic)

**The S604 handoff flagged the real risk:** "audit every list query for
`retired_at IS NULL` — a missed filter is how a retired unit silently keeps
getting billed or booked." **~120 files touch `units`.** Auditing all of them
perfectly, forever, against every future query, is not a thing that holds.

**So it is enforced STRUCTURALLY instead, exactly the way `owner_use` was:**
1. **No new lease** — the S604 owner_use trigger was widened into
   `reject_lease_on_unavailable_unit`, so all five lease-creation paths are
   covered at once (landlords.ts ×2, esign.ts, bookingLeaseDraft,
   applicationLeaseDraft). There is now exactly ONE place answering "may this
   unit hold a lease?".
2. **No new booking** — `reject_booking_on_retired_unit` on `unit_bookings`.
3. **Never billed** — **falls out of (1)**. `platformFeeAccrual` counts distinct
   units with an ACTIVE LEASE plus short-stay booking nights; a unit that can't
   hold a lease or take a booking can't be billed. Same anti-cheat shape as
   owner_use, which also needed no billing code.
4. **Hidden from pickers** — the only genuinely query-side concern, and a small
   findable set: `unitAvailability.findAvailableUnits`, the `getVacantUnits`
   agent tool, and `GET /api/units` (retired **excluded by default**, fail-closed;
   `?includeRetired=true` opts in).
5. **Kept in reports** — deliberately not filtered. History surviving is the point.

Retirement requires the unit be free first (no active/pending lease, no future
booking), which is what makes (3) true rather than hopeful.

`POST /api/units/:id/retire` clones by **explicit column list**, and
`unitRetire.test.ts` fails if any new `units` column isn't classified as copied
or deliberately reset — so the clone can't silently go stale as columns are added.
Eviction state, scheduled activations and OTP enrollment deliberately do NOT carry.

**UI:** Units page has an Archive action per row, a "Retired" filter toggle,
strikethrough + RETIRED badge, and no actions on a retired row (closed record).
Verified end-to-end on a throwaway unit, then cleaned up — **zero retired units in
prod, Oak Park untouched.**

---

## 5. ⭐ DEPOSIT-INTEREST ADMIN SURFACE — built, deployed

S604 built the whole 50-state catalog and the earned-vs-owed spread engine and
left both readable only in psql. `getPoolSpreadByMonth()` had no route and no
consumer at all.

`admin/deposit-interest` (**super-admin only** — `earned`/`spread`/`market_rate`
are GAM's margin; S603 and S604 each had to strip these from a landlord/tenant
surface already). Two tabs: **pool spread** by month, and the **state catalog**
joined against custody rules.

Rate display is **basis-aware**, which caught two real misreadings on the way in:
- FL stores `annual_rate_pct 5` AND `actual_share_pct 75` (§ 83.49 lets the
  landlord pay 5% flat OR 75% of actual). Showing only "5%" misstated the rule →
  now "5% flat, or 75% of actual".
- NY/PA store `annual_rate_pct 0` with `admin_retention_pct 1`; reading the rate
  alone rendered "actual earned" and silently dropped the retention → now
  "actual − 1% admin".

### ⚠️ LIVE CORRECTNESS GAP SURFACED — IL and NM
Both are `index_linked` with `annual_rate_pct = 0.0000`, so **the engine computes
$0 owed in two states that genuinely owe interest.** Harmless today (no landlord
in either), a real under-payment the moment one signs up. The admin page now
banners this rather than burying it. CT has a 1.5% pre-1994 floor as fallback.
**This is more than the "annual refresh" the S604 list called it.**

Catalog counts as of now: 16 obligations · 39 no-obligation · **30**
custody-supported · 21 blocked. (S604 handoff said 26 supported; later migrations
moved it — not a regression, just noting the doc is stale.)

---

## 6. Test + deploy state

- **144 passing** across the 8 suites touched (unitRetire 11, units 20,
  units-gap-close 56, bookings 8, onboardingBooking 7, landlordWelcomeOutreach 12,
  platformFeeAccrual 10, admin 20). API + landlord + admin typecheck clean.
- **API** rebuilt + `launchctl kickstart -k gui/501/com.gam.api` ×5.
- **MARKETING deployed** — `com.gam.marketing` kickstarted. Note: this service
  reads `src/index.html` **once at startup**, so a restart IS the deploy. It was
  not optional — the outreach job was already live and minting `#onboarding/`
  links the old page couldn't parse.
- **LANDLORD deployed** — prod serves `index-hrcm82MI.js`, matches local build.
- **ADMIN deployed** — prod serves `index-Dgm94ryY.js`, matches local build.
- `cleanupAllSchema` now clears `audit_log` before `users` (the retire route
  writes an audit row; without this the FK violation surfaced in the NEXT test's
  beforeEach, not the one that caused it).
- **Nothing committed.**

## 7. MIGRATIONS APPLIED (to `gam`, LIVE) — 3
`20260815100000` landlord welcome outreach (`welcome_outreach_sent_at` +
backfill-as-sent) · `20260815110000` onboarding booking tokens + onboarding
availability seed · `20260815120000` unit retire & replace (columns + widened
lease trigger + booking trigger)

---

## 8. ▶ NEXT

**Nic's, still the only hard gate on money:**
- **Connect KYC** — verified against the live DB today: `stripe_connect_account_id`
  is NULL on **every** landlord including `oakparkaz@gmail.com`. ~10 min, EIN + bank.

**Date-pressured (Aug 31, 16 days):**
- Oak Park electric submeters per spot + a **backdated baseline read**. Without a
  baseline the first cycle bills NOTHING and says nothing — the engine returns
  "no prior reading — first cycle baseline" and stays silent. Needs Nic's readings
  from the old system.

**Blocked on a Nic DECISION, not on code:**
- **Bank step before units.** The punchlist files this under "STRUCTURAL — DECIDE
  before more landlords onboard", and it is not a reorder: the wizard has **no
  unit step at all** (profile → property → bank → agreement). Options: (a) add a
  units step + fee quote before bank, (b) make bank deferrable so onboarding can
  complete without it, (c) just move bank last. **Charlie is the evidence this
  matters** — he quit at this wizard.
- **Multi-LLC at signup** — signup accepts exactly one entity with no way to add a
  second. DB and portfolio views already handle multi-entity (`landlord_members`);
  it's purely a flow gap. Punchlist calls it "common, not an edge case".

**Claude, unblocked:**
1. **IL/NM index values** (see §5) — upgrade from "annual refresh" to a real fix.
2. **Marketing telemetry** — zero `portal='marketing'` events ever, so no signup
   has acquisition attribution. Today made this concrete.
3. **Register-form phone validation** — the onboarding form formats/validates,
   the register form takes `z.string().optional()` and accepted an undialable
   number from our first real customer.
4. Rest of `ONBOARDING_PUNCHLIST.md` (~13): RUBS at onboarding, opening-read
   prompt, carried tenant balance, physical/mailing address, property-type
   multi-select, land-on-add-unit.
5. Maturity buckets — still blocked on the Jiko question.
6. Agent sweep cluster #6 (27 articles, BY HAND, no fan-out) — untouched.
7. Snowbird 2b, add-and-pay frontend, seasonal pricing — untouched.

## QUICK-REF
- Restart API: `cd apps/api && npm run build && launchctl kickstart -k gui/$(id -u)/com.gam.api`
- Deploy marketing: `launchctl kickstart -k gui/$(id -u)/com.gam.marketing` (reads index.html at boot)
- Deploy a portal: `npm run build && npx vercel build --prod && npx vercel deploy --prebuilt --prod --yes`
- Tests: `cd apps/api && DB_NAME=gam_test npx vitest run <file>` (NEVER without `DB_NAME=gam_test`)
