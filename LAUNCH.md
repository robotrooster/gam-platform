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
