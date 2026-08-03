# SESSION 577 HANDOFF — commit backlog + product batch + Checkr go-live

**Theme:** Consolidated 14 uncommitted sessions to git, then shipped a large
product batch (unit types, tenant surveys, retroactive late fees, late-fee gate
removal + UI rework), took **Checkr live**, re-wired background-check billing to
applicant-pays, and built a general landlord→tenant credit. Everything below is
**committed + pushed** — this was the "get it all safe + keep building" session.

**Repo:** `~/gam`. Dev servers running (landlord :3001, tenant :3002, …). Dev
portals → **prod** API on :4000 (`com.gam.api` launchd), **rebuilt +
kickstarted many times** this session — current code is LIVE. Demo landlord:
`james@demo.dev` / `landlord1234` (dev @demo.dev email-2FA OTP is suppressed).

**GIT: fully committed + pushed. `origin/main` = `dd01a7e` (0 ahead / 0 behind).**
Session commits, in order:
- `5b12bb1` — S563–S576 consolidation (14 sessions, 276 files) — the big de-risk.
- `4f360db` — unit types + campsite, platform-fee rule, tenant surveys,
  retroactive late fees, Checkr live keys + default flip.
- `4ad556a` — screening applicant-pays re-wire.
- `dd01a7e` — general landlord→tenant account credits.

**Migrations applied this session (all live):**
- `20260802120000_unit_types_parking_boatslip_landlot.sql`
- `20260802130000_property_surveys.sql`
- `20260802140000_late_fee_accrual_from.sql`
- `20260802160000_unit_type_campsite.sql`
- `20260802170000_landlords_default_provider_checkr.sql`
- `20260802180000_tenant_credits.sql`

**Secrets:** Checkr live keys written to `apps/api/.env`
(`CHECKR_API_KEY=ckr_sk_live_…`, `CHECKR_WEBHOOK_SECRET`); backup at
`apps/api/.env.bak-checkr-20260802`. `.env` + `.bak` are gitignored (verified).

---

## §A — SHIPPED + VERIFIED THIS SESSION

### 1. Unit types 7 → 11
Added **parking, boat_slip, land_lot, campsite** (all bookable short-term).
Short-term/vacation rental = a booking MODE, not a type. **Cabins = a subtype**
(a dwelling; landlords name it via the per-property subtype system). Migrations
rebuild the 4 unit_type CHECK constraints. 60 unit tests green. Memory:
[[gam-unit-types-expansion]].

### 2. Platform-fee rule (Nic-locked: by PRODUCT/SERVICE LEVEL)
- Occupied monthly, ANY type → **$2/occupied unit/mo** (min $10/property).
- **Bare lodging sites (rv_spot, campsite, boat_slip)** → **$2 × CEIL(nights/30)**
  short-term (NIGHTS_AGGREGATION). RV park = campground = marina, priced alike,
  no monthly-vs-nightly arbitrage.
- **Furnished lodging (apartment, single_family, mobile_home, hotel_room)** →
  **5%** short-term (motel room is furnished → 5%, NOT a bare site).
- Non-lodging (parking, land_lot, commercial) → monthly $2 / short-term 5%.
- Basis decision resolves the RV-vs-motel "same business" inconsistency (it's
  bare space vs furnished/serviced). platformFeeAccrual tests green.

### 3. Property-scoped tenant surveys
Google-Forms-style: landlord builds/sends/reads results + copy-to-property (fresh
responses); tenant answers in **Communication → Surveys**. **Always anonymous**
(retaliation protection) + **every question required** (server-enforced; "NA" if
N/A). MC + text only. Landlord nav "Surveys" (owner-only). 7 tests green.
Memory: [[gam-tenant-surveys]].

### 4. Retroactive late fees
Per-(property,unit_type) `late_fee_accrual_from`: **grace_end | due_date |
due_date_inclusive**. Once grace lapses the daily amount counts back to the due
date (verified against ARS §33-1414 "$5/day from the due date" — applicant… i.e.
tenant-facing AZ MH case). No initial fee when retroactive. **Policy default
due_date_inclusive; leases default grace_end** (existing signed leases NEVER
change — lease-is-law). Threaded through billing (jobs/lateFees), resolver,
esign stamp, lease PDF, PropertyLateFeeSection UI. 5 date-math + 3 billing tests.
Also fixed a latent leasePdf percent-vs-percent_of_rent bug. Memory:
[[gam-retroactive-late-fee-design]].

### 5. Late-fee gate REMOVED + UI rework
No late fee is now the **automatic default** (no row = no fee). Retired the
S537 forced-decision gate (`assertLateFeeDecision*` are no-ops; unit-add /
onboarding / CSV no longer block); removed the "charge a fee / no fee" dropdown;
DELETE of a fee allowed anytime (reverts to no fee). s537 suite updated (80
green). Late-fee UI: all fields visible at once, permanent description, pop-ups
removed. Memory: [[gam-late-fee-consistency]] (layer 3 marked RETIRED).

### 6. Checkr LIVE
Live keys wired + **validated against the Tenant API** (GET /orders → 200).
`landlords.background_provider` default flipped **mock → checkr** (new real
landlords screen live; demos stay mock). Webhook endpoint (Nic registered in the
Checkr dashboard): `https://api.goldassetmanagement.com/api/background/webhook/checkr`.
Memory: [[gam-checkr-billing-model]].

### 7. Screening billing re-wire — APPLICANT PAYS
The **applicant pays ~$44.60 up front, before the check runs, on BOTH routes**
(Nic — the landlord route was still S561 landlord-billed). Landlord route =
applicant PaymentIntent routed `on_behalf_of` the landlord's Connect (landlord =
property lock / merchant-of-record / FCRA purpose, nets $0; requires
connect_charges_enabled → 409 if not). Removed the landlord accrual on the intake
path. `/price` returns the real fee on both routes. Restored the Stripe Elements
card step in the tenant BackgroundCheckPage (S561 had stripped it). Fixed the
mock-intent prefix (pi_bgc_mock_ → pi_intake_mock_). 30 background tests green.

### 8. General landlord→tenant account credits
Landlord issues a credit for **any** reason (screening cap, late-fee refund,
overcharge, goodwill) from the **Payments page → Issue Credit**. Applies to the
tenant's next rent invoice (isolated consumption block in invoiceGeneration,
mirrors lease_prepaid_credits, SEPARATE source), **funded by the landlord**
(tenant owes less → landlord receives less rent). **INDEPENDENT of work-trade**
(Nic: work-trade stays hours-logging only — untouched). API /api/tenant-credits
(issue/list/void/mine). 7 tests; 68 money-suite tests green, no regressions.
Memory: [[gam-tenant-account-credits]].

---

## §B — OPEN / NEXT

1. **Launch blockers (Nic's — nothing moves without these):** **N2** real Oak
   Park landlord account (real business email); **N4** Connect KYC; **N3** enter
   real property/units/leases. Then Claude runs **C4** live-fire money test +
   **C5** invite→login→pay walkthrough. (LAUNCH.md §1.)
2. **Checkr live-fire not yet run** — needs a real landlord + real applicant +
   ~$44 real money (waits on N2/N4). Key validated; a real order hasn't run.
3. **Visual QA pending (dev 2FA blocks Claude login):** tenant survey pages,
   tenant screening **card step** (Stripe Elements), landlord **Issue Credit**
   modal, reworked late-fee UI. All typecheck-clean + pattern-proven; worth Nic's
   eyeball.
4. **Screening re-wire follow-on:** the retroactive late-fee lease-stamp resolves
   `late_fee_accrual_from` at sign-completion (not frozen at draft like dollar
   amounts) — documented simplification, tighten to draft-freeze only if it ever
   matters ([[gam-retroactive-late-fee-design]]).
5. **Tenant-facing credit display** (GET /api/tenant-credits/mine exists) not yet
   surfaced in the tenant portal — credits auto-apply + reduce the shown balance,
   so it's a nice-to-have.

## §C — HOW TO START
1. Read this file + recall memories: [[gam-checkr-billing-model]],
   [[gam-tenant-account-credits]], [[gam-unit-types-expansion]],
   [[gam-tenant-surveys]], [[gam-retroactive-late-fee-design]],
   [[gam-late-fee-consistency]], [[gam-prod-api-restart]], [[oak-park-launch-sprint]].
2. Everything is committed + pushed + live. Prod-API changes = rebuild
   (`cd apps/api && npm run build`) + `launchctl kickstart -k gui/$(id -u)/com.gam.api`.
3. Run only directly-affected test suites ([[test-scope-focused-changes]]).
4. Launch is gated on Nic's N2/N4/N3, not code.
