# GAM — Launch & Backlog (single source of truth)

Consolidates the former OAK_PARK_LAUNCH.md + DEFERRED.md + the S559 utility
spec. Shipped items are deleted, not tracked here — the audit trail is git
history. Verbose originals of anything below are recoverable from git.

**State as of 2026-08-22 (S617): every launch blocker is cleared.** Nothing in
sections 1 and 2 is waiting on code, a vendor, or a decision. What has not
happened is the LAUNCH — Oak Park has no tenants yet, and that is data entry at
Nic's pace, not a build. Sections 3 and 4 are a real backlog and are NOT done;
do not read "launch blockers cleared" as "the doc is finished."

Flex Suite (FlexPay/FlexCharge/FlexDeposit/FlexCredit) ships **hidden behind
feature flags** — `system_features` + `isFeatureEnabled()`; flags stay off,
products don't render, crons no-op.

---

## 1. Oak Park launch — CHECKLIST CLEARED

Original scope: tenants log in + pay rent. Every item verified against the live
database, the running services, and the Stripe live account on 2026-08-22.

**Nic:**
- **N1 — Stripe live account** ✅ 2026-07-21. `sk_live`/`pk_live` + both webhook
  secrets wired in `apps/api/.env`.
- **N2 — Real Oak Park landlord account** ✅ `oakparkaz@gmail.com` owns
  *Oak Park Motel and RV*. Separate from the demo landlords — see
  [[oak-park-gam-entity-separation]].
- **N3 — Manual data entry** 🟡 **the only thing standing between here and a
  live tenant.** Done: 30 units (21 rv_spot, 8 mobile_home, 1 apartment), 3 unit
  subtypes, a late-fee policy for all three unit types, utility rates for
  electric/trash/water, 30 meters with 82 meter→unit assignments and 27 readings,
  one bank account on file. Not done: **no tenants, no leases, no neighbour
  service agreements, and the owner-occupied units are still marked `vacant`.**
  Order that saves a pass: neighbour service points → lease templates → mark the
  owner-occupied units → invite tenants.
- **N4 — Connect KYC** ✅ `acct_1U5VpMDz9hhZGjwY` — charges, payouts and
  details-submitted all enabled.
- **N5 — Vercel Pro** ⬜ Nic's click. Not blocking; the portals are live on the
  current plan.

**Claude:**
- **C1 prod flip** ✅ 2026-07-20 (com.gam.api launchd, NODE_ENV=production,
  KeepAlive, ENCRYPTION_KEY, crash-respawn verified).
- **C2 prod env audit** ✅ 2026-07-20 (all *_APP_URL on prod domains, portals on
  the prod API, tunnel + marketing verified, nightly backups current).
- **C3 Stripe live wiring** ✅ 2026-07-21. Live keys, prod webhook endpoint +
  both secrets, signature verification on platform + connect webhooks, Financial
  Connections live in the ACH charge/setup, raw webhook payloads stored
  append-only.
- **C4 live-fire money test** ✅ **Real money has moved, both rails.**
  - Card, 2026-08-10: $2.00 rent + $0.33 fee = **$2.33, succeeded**, available
    2026-08-13, and a **$1.21 payout reached a bank the same day** — a complete
    round trip. (Stripe's own fees on that charge came to $0.88, which is what
    drove the card repricing to 3.5% + $0.55.)
  - ACH, 2026-08-19: $2.00 rent + $6.00 fee = **$8.00**, `available_on`
    2026-08-25 — four business days, exactly on schedule.
  - Both `livemode: true`. **Not re-testing this.** Nic, S617: *"if the code
    works, it works... you should verify everything and be able to know that
    it's good because of how we've already moved money."*
  - One caveat recorded, not a gate: both charges carried no
    `transfer_data.destination` and no platform cut, because the landlord they
    were booked under has no Connect account. The split-to-a-landlord path is
    covered by tests, not by a live charge.
- **C5 invite → login → pay on PROD** ✅ Real tenant account, password set,
  email verified, last login 2026-08-17, live Financial Connections bank
  connection active, and the two charges above are theirs.
- **C6 August billing dry-check** — n/a. Oak Park has no leases, so there was
  nothing for the invoice cron to produce. Re-do it the evening before the first
  month Nic has real leases entered.
- **C7 rolling QA behind Nic's data entry** — starts when N3 does. Each occupied
  unit → active lease, correct rent, tenant email present, invite sent/accepted.
  Report gaps daily, never edit his data.
- **C8 launch-day watch** — invoice cron, first payments, webhook deliveries,
  email log; fix breakage immediately.

**Checkr background checks** remain Nic-pending on credentials (vendor).

---

## 2. Infrastructure — no launch gates left, only scale triggers

- **Production cron runner** — node-cron runs in-process in the API, so a
  restart drops a pending firing. Now bounded rather than dangerous: payouts are
  DB-backed triggers (`payout_triggers`), so a dropped firing is picked up by
  the next run and costs a day, not the money. A dedicated worker or managed
  cron is a scale item.
- **Deploy config / host pick** — self-hosted on the Mac Studio via launchd +
  Cloudflare tunnel ([[gam-studio-selfhost]]). A managed host (Render fastest)
  is the scale trigger, not a launch gate.
- **Database backups + PITR** — nightly dump → local + iCloud, running and
  current (verified 2026-08-22 03:30). Managed-Postgres PITR comes with the host
  pick.
- **Stripe live activation** ✅ see C3/C4.
- **Resend domain auth** ✅ verified + delivering ([[gam-launch-accounts]]).

Shipped infra (do not redo): the Vitest suite (**305 files, 5,093 tests**), CI
(.github/workflows/ci.yml), Sentry on API + 9 frontends, structured logging
(pino), rate-limit + login lockout + password reset + email verification + TOTP
2FA (admin mandatory), legal ToS/Privacy (lawyer review still advised before
broad public rollout), CSV imports from 8 PM platforms.

---

## 2b. Current work — agreed order (S617, 2026-08-22)

Nic is entering his three Oak Park lease templates and sending portal invites.
Everything here is meant to land BEFORE real tenants are on the platform. Nic:
*"I wanted to knock all those changes out before real people got on there."*

1. **E-sign auto-draft workflow** — verify the path Nic is about to use for
   real: upload template → auto-place fields → draft → send. Not yet checked
   this session.
2. **AI agents — ✅ DONE (S617).** Knowledge re-ingested, scope enforced, manner
   fixed, and — the part nobody knew about — they had been **inventing account
   data**.
   - ✅ Knowledge re-ingested: 199 chunks / 67 articles across all four scopes.
     Three articles written that did not exist (neighbour utilities, one-off
     charges, the tenant side of a utility-only bill), and a **pricing answer
     corrected from 5% to 3%** — it had been contradicting the Business Terms
     of Service a landlord signs.
   - ✅ Scope: an agent asked about the other side of the platform now answers
     as someone who has never heard of it, avoiding BOTH tells — the robot
     ("not in my knowledge base") and the guard ("I can't discuss that").
     All seven profiles; the landlord agents had had no rule in either
     direction. Backstopped deterministically in `scopeGuard.ts`.
   - ✅ Manner: only Lucy had ever been told to write like texting, and the
     paced-bubble feature every chat surface implements was never firing
     because nothing asked the model to use blank lines. Plus plain-text-only
     (the bubbles render no markdown) and a rule against reciting articles —
     one answer went from 1,489 characters to 483.
   - ✅ Reply cadence: Sent → unnoticed (10-20s cold, 3-7s engaged) → Seen →
     read → typing. `packages/shared/src/chatCadence.ts`.
   - ✅ **Fabrication.** Testing the real path (`runAgentSession` with a signed-in
     actor) rather than the bare engine found the agents inventing balances,
     vacancy counts, maintenance requests and whole properties. Fixed and
     bounded: a tool-demanding question that gets no tool call is retried, and
     an invented answer is suppressed rather than sent.
   - **`services/agentBattery.ts`** is the regression net — 25 cases through
     the production path, every figure checked against SQL. **Currently 25/25**
     (fabricated=0, leaks=0, placeholders=0, markdown=0, repetitive=0), and the
     earlier 18-case form ran clean twice consecutively.
     `DB_NAME=gam npx ts-node src/services/agents/agentBattery.ts`
     **Do not run it alongside the vitest suite** — together they starve the
     36B model server, which crashes and respawns mid-run.

3. **Demo server — split the seed data off the live database.** Nic: *"when
   we're having sales calls and demos, I can walk through a process without
   showing real customer data."* Wants seeded data at EVERY STAGE of a flow —
   a template being built, one with its boxes already placed, one signed — so a
   demo can jump straight to the relevant moment instead of performing the
   setup. Also removes the demo landlords (Thornton Properties, Reyes Rentals)
   and their 37 payment rows from the production database, where they currently
   sit alongside real money.

---

## 3. Post-launch backlog

**Deposit custody — Jiko T-bills, near-term, NOT a launch blocker (Nic, S604).**
Hold pooled deposit principal in Treasury bills via **Jiko**, in as many states
as that vehicle is permitted. Two open pieces, both deliberately post-launch:
1. **The states Jiko can't cover.** 19 states carry trust/escrow or
   "federally insured depository institution" custody language and 12 require an
   IN-STATE institution (CT DE GA IL MD MI NC NM NY OH WA WV) — a brokerage-held
   T-bill is not a federally insured depository account, so those need a
   different vehicle (FBO demand account, or IntraFi ICS/CDARS for pooled FDIC
   coverage). Maryland § 8-203 is the one that explicitly permits both insured
   CDs and federal government securities. Figure out per-state later; do not
   block launch on it.
2. **Negative-spread states/unit types.** Where the statutory rate exceeds the
   net yield (AZ mobile home owes 5% under § 33-1431(B); assume ~3% net after
   Jiko's cut), GAM loses on custody. Note § 33-1431(B) obligates **the
   LANDLORD**, not the custodian — GAM taking custody does not make GAM the
   obligor, and per the standing "GAM never absorbs fees" rule the shortfall
   should not land on GAM. Options: leave those deposits `held_by='landlord'`,
   or settle the top-up against the landlord. Needs counsel before it is real.

Liquidity constraint that bounds every vehicle choice: AZ § 33-1431(C) requires
return within **fourteen days** of termination. That rules out long CD ladders
as the primary vehicle and sizes the demand buffer.

**NJ + SC — ENCODED (S604). There was NO corpus gap.** Both states' landlord-tenant
acts were in `state_law_section_texts` all along under act_key
`general_landlord_tenant` (NJ 43 sections + 50 eviction + 10 manufactured-home-park;
SC 90 sections = the Residential Landlord and Tenant Act). The earlier "gap" was a
QUERY FILTER that only looked at `act_key='residential'`. Re-swept with no act_key
filter, which also turned up **Missouri § 535.300** (verified negative — interest is
the landlord's) and widened **Illinois** to RV parks. Both NJ/SC rows are now
confirmed verbatim against the corpus (migrations `20260814190000`, `20260814200000`):
- **NJ § 46:8-19** — owes `actual_earned`, ALL of it. No administrative retention
  (unlike NY/PA's 1%), paid annually. GAM spread in NJ is **zero, never
  negative**. Non-compliance = deposit + 7%/yr against rent. Custody:
  `needs_research` — an "insured money market fund" is expressly permitted at
  10+ units (closest any statute comes to allowing GAM's vehicle), but the
  qualifying criteria are unread and under 10 units an in-state bank is required.
- **SC § 27-40-410** — no interest requirement, no account restriction, no
  deposit cap. Custody `supported`, obligation `none`: **pure spread**.

**ALL 50 STATES READ (S604) — interest AND custody. Treasuries lawful in 26.**
Read per (state, ACT), ~100 pairs — Arizona alone has four tenancy acts and they
disagree. `supported` (26): AL AR AZ CA HI IN LA MD MN MS MT NE NM NV OH OR RI
SC SD TX UT VA VT WI WV WY · `blocked` (21): AK CO CT DE FL GA ID IL KY MA ME MI
MO NC ND NH NY OK PA TN WA · `needs_research` (3): **IA KS NJ — READ, not
unread.** Their text is recorded; what is unresolved is whether GAM's vehicle
qualifies under it, which is a counsel/diligence question, not more statute
reading. IA + KS expressly permit a COMMON (pooled) trust account; NJ permits an
insured MMF from an investment company "based in this State".
- **TEXAS is fully open** — largest rental market in the country, zero account
  requirement and no interest obligation.
- **MICHIGAN § 554.604(1)** is the best workaround found anywhere: a cash or
  surety bond filed with the secretary of state lets the landlord "use the
  moneys so deposited for any purposes he desires". **NC, GA, DE** also offer
  bond alternatives to the trust account.
- **OHIO § 5321.16** was a hidden 5% obligation — the earlier flag came from
  § 4781.25 (manufactured-housing BROKER trust accounts), which is unrelated.
- 16 obligation rows; only **AZ mobile home (5%), RI mobile home (3%) and OH
  (5%)** are fixed-rate and can run negative against market yield.

**(superseded) earlier partial read —**
After re-sweeping with no act_key filter and READING every hit:
`supported` **AZ MD OR SC** · `blocked` **AK CO DE FL GA ID KY MA ME MO NC ND NY
OK PA WA** (16 — all require a bank/escrow/trust ACCOUNT at a financial
institution; a brokerage T-bill is not one) · `needs_research` **CA CT IA IL KS
MI NJ NM NV OH VA WV** (12 unread).
- **AZ is supported** — no account requirement anywhere in §§ 33-1321/1431/2121.
  Oak Park can hold Treasuries.
- **Bond alternatives** exist in **NC § 42-50, GA, DE** — the realistic path in
  those states instead of a bank product.
- **IA + KS expressly permit a COMMON (pooled) trust account** — the most
  favourable wording found; worth reading closely, they may be cheap wins.
- **CO § 38-12-207 bars pooling outright** for mobile home parks (separate trust
  account per deposit, no commingling) — but the landlord keeps the interest.

**Lesson for future statute sweeps:** never filter `state_law_section_texts` by a
hand-picked act_key list. 16 states file landlord-tenant law under
`general_landlord_tenant`, and other categories (`commercial`, `rv_park`,
`eviction`) carry deposit provisions too. Sweep with NO act_key filter and
exclude only the clearly irrelevant (property_tax, broker_licensing, mortgage).



**Flex Suite test battery (before ANY flag flips):** supersedence FIFO across
all sources + boost cap + idempotency; FlexDeposit custody installments (retry
→ 'missed', ACH-return pass-through, $3/mo custody, lease-end disbursement
capped at collected — acceleration RETIRED, no recourse); FlexCharge statement
→ pull → merchant Transfer + dispute lifecycle; FlexPay grace-end front-Transfer
+ pull-day + OTP dedup + 2-NSF suspension; FlexCredit product semantics call
(bureaus, qualifying events, $5/mo) — vendor-blocked on Esusu.

**Other:** frontend product analytics (first-party product_events + TelemetryPing
already shipped S550; PostHog/etc. optional); DB scale tuning past ~100
properties (pool sizing, read replicas, query-plan review); POS multi-terminal
SSE realtime (only when 20+ simultaneous carts or multi-staff carts ship);
tenant-pool endpoint refinements (S177, scope TBD); mobile/responsive +
WCAG-AA audits; load-testing baselines; support infra; GDPR/CCPA export +
deletion flows; vendor-outage kill switch.

**Vendor-blocked:** Plaid production keys (tenant ACH live); Stripe Terminal
prod access + hardware (POS card-present); Checkr Partner credentials. (Stripe
Connect agreement already signed.)

---

## 4. Deferred designs (Nic — captured, not scheduled)

### FlexPay two-payer on one lease (deferred; single-payer works today)
Case: two disabled co-tenants, benefits land on different days, neither payment
alone covers rent. **Decided model:** each payer is an INDEPENDENT participant —
own float, own **$25** fee ($50 total for two), own pull day (cap
`FLEXPAY_MAX_PULL_DAY=28`), own failure/retry/ACH-return/90-day lockout, own
SSI/SSDI verification. Rejected the "one $25 split two ways" model (twice the
risk/float/ACH cost, unfair to solo enrollees, free-rider). Enrollment stays
per-tenant (existing schema fits). **Consumer-protective:** if combined fees
don't beat the late fees they already pay, GAM DECLINES rather than sell a
worse deal (standing FlexPay principle). One-enrolls-one-doesn't is the common
case and falls out cleanly. Rent owed stays PER LEASE
([[gam-rent-obligation-principle]]) — the per-person share is FlexPay-internal
only.
**Why deferred:** case-by-case "who owes how much" = ability-to-repay =
underwriting, which breaks the no-credit-decision structure ([[flexsuite-product-rules]]).
Safe path when resumed: **household DECLARES the split; GAM validates against a
flat mechanical rule** (e.g. % of verified income) — declaration + validation,
never assessment. **The line: front against the OBLIGATION, never the INCOME.**
Open: whether 3+ payers is ever allowed.

### Tenant-led landlord acquisition (idea, not scoped)
Open, disclosed referral: the tenant tells THEIR OWN landlord about GAM; GAM
never cold-contacts. Bounty pays on conversion only. Refinements before build:
- **Collect the lease** — it's an intelligence asset: names the actual manager
  (often a PM company = the decision-maker), powers a "who declined" heat map
  that kills dead leads. Plugs into existing PM schema (`pm_companies` can be
  prospect/contacted/declined pre-customer). Extract→index; purge the document
  on a retention window; admin-only ([[gam-nothing-public-rule]]); explicit
  tenant consent at upload; honest App Store privacy label (see APP_STORE_PLAN.md).
- **Moved-out tenants still get paid** (reach via forwarding addr / emergency
  contact on the lease).
- **Bounty scales with rent × unit count** (custody float + card % scale with
  rent; platform/ACH are flat; FlexPay float runs the OTHER way). One month's
  rent defensible; scale variable undecided.
- **Disclosure built into the referral artifact** (FTC endorsement rules), not
  the tenant's memory.
- **⚠️ Bounty can HARM an SSI tenant** — cash = countable income; paying rent =
  ISM; either can trigger overpayment clawback + 1099. Keep the amount under
  thresholds, disclose the benefits impact, benefits-counsel read advised
  ([[flexsuite-product-rules]]).
- FlexCredit as a parallel wedge — standalone tenant value (Esusu rent
  reporting) whether or not the landlord ever joins.

---

## 5. Utility turnover reads + front-desk metering — ✅ SHIPPED S559
Full detail in memory [[gam-utility-turnover-reads]] (and git history of the
former UTILITY_TURNOVER_READS_SPEC.md). Point-in-time reads; turnover reference
reads + broken-meter lowest-comparable billing; `utility.read_meters` front-desk
key + blind-leak lock; special-read endpoint + UI; calendar-derived reads-due
to-do; check-in inline-read enforcement (built the front-desk check-in action)
+ right-click-edit on the master schedule. 113 API tests green.

---

## Other standalone docs (not merged — active future references)
- `APP_STORE_PLAN.md` — Capacitor iOS plan, deferred until after Oak Park launch
  ([[gam-app-store-plan]]).
- `AUTO_FIELD_PLACEMENT_SPEC.md` — e-sign auto field placement
  ([[gam-lease-renewal-and-autofield]]).
- `LAUNCH_DECISIONS.md` — older launch decision log (candidate to fold in later).
