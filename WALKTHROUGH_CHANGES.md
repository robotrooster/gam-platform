# GAM Walkthrough — Open Items

Started from the 2026-06-20 portal walkthrough. **Completed items were removed
2026-06-27** (done + verified; history lives in git + the SESSION_*_HANDOFF files;
S519 = Master Schedule/booking/RV, S520 = FlexSuite readiness). What remains below
is only what's NOT done — almost all vendor/infra-gated or deferred as non-launch.

Standing rule: **Operations ↔ Admin overlaps mirror automatically** — a change to
one that overlaps the other applies to both.

Standing rule (S507, Nic): **At launch GAM does NOT advance funds and does NOT
absorb/eat any fees.** No rent advance (OTP), no disbursement guarantee, no
GAM-eats-chargebacks/ACH-returns copy. Pricing is flat **$2/occupied unit**
(vacant $0, $10/property min) — no tiers. FlexDeposit = custody, not advance.

---

## Vendor / infra-gated — flip on at go-live, no code to write

- **Checkr live credentials** (lands Monday) — Background Checks AND both rental-application
  flows (specific-property + general) are code-complete. Set `CHECKR_API_KEY` / `CHECKR_PACKAGE` /
  `CHECKR_WEBHOOK_SECRET` + `landlords.background_provider='checkr'`.
- **Stripe live keys** — exercise the hosted deposit Checkout + payouts end-to-end (webhook
  crediting is unit-proven via simulated events).
- **Twilio** — outage/emergency SMS (stub present; Service Interruptions). Goes live once wired.
- **Wildcard subdomain DNS + TLS** (`*.gam-domain`) — needed for the public per-property booking
  site to go live (slug-based API already works on a path in dev).
- **Self-host Nominatim + OSM** — geocoder data sovereignty (app already reads `GEOCODER_URL`;
  the Maps deep-link navigates by raw address so it doesn't depend on it).
- **HTTPS + `VITE_CUSTOMER_PORTAL_URL`** — customer/booking apps in prod (Web Push needs a secure
  context; a dev VAPID pair is the fallback).
- **Counsel review of the FlexDeposit custody ToS** — legal gate, not code.

## FlexSuite — ready but hidden, flip on soon (audited + hardened S520)

All four products are flag-OFF (`*_rollout_visible` rows seeded FALSE; `setFeatureEnabled` now upserts so the
super-admin toggle actually works) AND frontend-hidden (`LAUNCH_HIDDEN` / `LAUNCH_HIDE_CHARGE`). Flip-on
procedure: SESSION_520_HANDOFF.md.

- **FlexDeposit** — ✅ ready (custody model, fully wired). CLAUDE.md "old advance code" note is stale.
- **FlexCharge** — ✅ ready for launch use (landlord-operated). Remaining: **standalone POS-operator accounts**
  — build as a `business_owner` capability (reuse the Business-portal auth/KYC; NOT a new role). Near-term per
  Nic, **after** the Flex products. Also: charge-accounts polish (blend POS+tenant names) is a hidden-surface tweak.
- **FlexPay** — ✅ completed S520: SSDI/SSI + FlexDeposit-funded gates, 90-day lockout, auto-disenroll on ACH
  suspend, re-priced retry + ACH-return pass-through, change-pull-day (next-cycle). Ready to flip on.
  - Follow-up: replace the `FLEXPAY_ACH_RETURN_FEE` constant with Stripe balance-transaction reconciliation
    once live keys are in (true per-return actual cost).
- **FlexCredit** — ❌ NOT built (~5%): vendor-blocked on **Esusu** (no client/reporting/billing/opt-out) +
  product calls (bureaus, qualifying events, billing). Now gated; do NOT flip on. Build is a dedicated session.
- **Per-product Flex invite flows** — surfaces stay hidden until the products unhide.

## Deferred — non-launch features (hidden / flagged off)

- **Fitness** (separate app, `LAUNCH_HIDE_FITNESS`): AI plan builder, leaderboard filters,
  nutrition/weight tracking, routines↔agent, dashboard Top-8, in-session routine timer.
- **Property Intelligence** (out of launch scope): data accuracy — city/field cross-contamination,
  sqft showing as units, per-county table mapping.
- **Admin-ops vacant/occupied unit-card drill-down** — needs a new admin-ops unit-level endpoint.
- **Native driver app** for zero-tap background GPS (future; Web Push covers customer messaging now).
- **Customer portal**: optional per-customer push toggle / quiet hours.

## Small open code items — not launch-blocking

All cleared. (Reports fee model, Team-page bank-account wording, sales-agent
prompt rename + de-guarantee, Master Schedule QR removal, stale junk
reservations — all done; history in git + handoffs.)

---

## Resume info

**Start everything:** `~/gam-start.sh` (models + Postgres + all apps via `dev.sh`)

**Demo logins:**
- Admin (3003, elevated, 2FA): `admin@gam.dev` / `admin1234` — get code: `~/gam-admin-code.sh`
- Operations / Admin Ops (3009): `admin@gam.dev` / `admin1234`
- Landlord (3001): `james@demo.dev` / `landlord1234` (also `maria@demo.dev`, `realestaterhoades@gmail.com`)
- Tenant (3002): `alice@tenant.dev` / `tenant1234` (also bob, carol, dan, eva, frank)
- PM Company (3011): `pmowner@pmcompany.dev` / `pm1234`
- Business (3012): `owner@business.dev` / `business1234`
- Fitness (3013): `demo.lifter@demo.dev` / `demo1234`, or sign up fresh

**Ports:** 3001 landlord · 3002 tenant · 3003 admin · 3004 marketing · 3005 pos · 3006 books ·
3007 property-intel · 3008 listings · 3009 admin-ops · 3011 pm-company · 3012 business ·
3013 fitness · 4000 api · 4001 property-api · 5432 postgres · 8080 chat model · 8081 embeddings
