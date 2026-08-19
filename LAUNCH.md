# GAM — Launch & Backlog (single source of truth)

Consolidates the former OAK_PARK_LAUNCH.md + DEFERRED.md + the S559 utility
spec (S559). Shipped items are deleted, not tracked here — the audit trail is
git history. Verbose originals of anything below are recoverable from git.

Feature work for launch is effectively done. Remaining launch blockers are all
**vendor / dev-infra / Nic-pending**, not feature code. Flex Suite
(FlexPay/FlexCharge/FlexDeposit/FlexCredit) ships **hidden behind feature
flags** — `system_features` table + `isFeatureEnabled()`; flags stay off at
launch, products don't render, crons no-op.

---

## 1. Oak Park launch (Aug 1) — tenants log in + pay rent

HARD SCOPE FREEZE: anything not here waits until after Aug 1. The DB Oak Park
was DoorLoop test junk — **purged 7/20**; Nic rebuilds manually under the real
business account. Checklist: `~/gam/OAK_PARK_LAUNCH.md` history in git.

**Nic (nothing moves without these):**
- **N1 — Stripe live account** ✅ DONE 2026-07-21. Sales-rep/account migration
  resolved; `sk_live`/`pk_live` + both webhook secrets are wired into
  `apps/api/.env` (backup: `.env.bak-pre-live-20260721`). Payment path is
  UNBLOCKED. (This doc previously called it the longest pole — stale; corrected
  2026-07-28.)
- **N2 — Real Oak Park landlord account**: register under the real business
  email; tell Claude which email (so prod QA hits the right landlord, never the
  demo/test accounts). See [[oak-park-gam-entity-separation]].
- **N3 — Manual data entry** (Nic's pace, real account): property → unit
  subtypes → units (unit-add forces a late-fee decision per unit type) →
  tenants/leases. Tenant EMAIL = the invite + login, the one field that matters.
- **N4 — Connect KYC**: complete embedded Stripe onboarding in the landlord
  portal once live keys are wired (~10 min w/ EIN + bank).
- **N5 — Vercel Pro**: click upgrade when Claude says the prod flip is done
  (straight to Pro at launch).

**Claude:**
- **C1 prod flip** ✅ 7/20 (com.gam.api launchd, NODE_ENV=production, KeepAlive,
  ENCRYPTION_KEY set; crash-respawn verified).
- **C2 prod env audit** ✅ 7/20 (all *_APP_URL → prod domains; Vercel portals
  live on prod API; tunnel + marketing verified; nightly backups current).
- **C3 Stripe live wiring** ✅ DONE (with N1, 7/21; code verified S562). Live keys
  in `.env`, prod webhook endpoint + both secrets set, signature verify on
  platform + connect webhooks, Financial Connections live in the ACH charge/setup,
  RAW webhook payloads stored append-only. Radar = dashboard-side.
- **C4 live-fire money test** (needs N1+N4): one small real ACH + one card
  against a test tenant → lands in Nic's Connect balance, app fee to GAM, then
  refund. Proof before any tenant pays.
- **C5 invite→login→pay walkthrough on PROD**: throwaway tenant, real inbox,
  set password, add bank via Financial Connections, Pay Now.
- **C6 August billing dry-check**: per lease Nic enters, verify Aug 1 invoice
  cron produces a correct payable rent invoice (rent_due_day, no move-in
  double-bill on migrated tenancies, lease's own late-fee class). Re-run eve of
  Jul 31.
- **C7 rolling QA** behind Nic's data entry: each occupied unit → active lease,
  correct rent, tenant email present, invite sent/accepted. Report gaps daily,
  never edit his data.
- **C8 launch-day watch (Aug 1)**: invoice cron, first payments, webhook
  deliveries, email log; fix breakage immediately.

**In launch scope but Nic-pending design:** Checkr background checks (moved in
7/21 — new tenants into vacant units; credentials were due "Monday"). FlexPay
stays tenant-portal demand-test only.

---

## 2. Remaining launch blockers (dev-infra / vendor)

- **Deploy config / host pick** — no Dockerfile/render.yaml/fly.toml. NOTE:
  currently self-hosted on the Mac Studio via launchd + Cloudflare tunnel (see
  [[gam-studio-selfhost]]); a managed host (Render fastest) is the scale
  trigger, not a launch gate.
- **Production cron runner** — node-cron runs in-process in the API; a restart
  drops pending firings. Fine short-term on the Studio; needs a dedicated worker
  or managed cron at scale.
- **Database backups + PITR** — nightly dump → local + iCloud is live (restore
  verified). Managed-Postgres PITR comes with the host pick.
- **Stripe live activation** — see C3 (blocked on N1).
- **Resend domain auth** — ✅ verified + delivering (per [[gam-launch-accounts]]).

Shipped infra (do not redo): full Vitest suite (618+ across 32 files), CI
(.github/workflows/ci.yml), Sentry on API + 9 frontends, structured logging
(pino), rate-limit + login lockout + password reset + email verification + TOTP
2FA (admin mandatory), legal ToS/Privacy (lawyer review still advised before
broad public rollout), CSV imports from 8 PM platforms.

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
