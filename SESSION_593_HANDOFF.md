# SESSION 593 HANDOFF — Sweep §16/19/20/21/22 combed; Listings marketplace + two-channel defrag BUILT; memory pruned

> Continues the S578→ pre-onboarding sweep (24 subsystems, in order). This
> session combed **Subsystem 16 (Storefront), 19 (PM companies), 20 (AI agents),
> 21 (Crons), 22 (Surveys/notifications/appointments)** — plus, from a
> design-flow review Nic pushed for, **built the listings marketplace** (the
> long-term public channel) and the **defrag** that makes both public channels
> converge on the Master Schedule. **Nothing committed** — the whole S578→S593
> sweep is still one deploy at the very end. Everything green.

---

## SWEEP STATUS (24 subsystems)

Done: **1–22 (except none — 16 was the skipped gap, now closed), plus 13 (early, S579).**
- 16 Storefront + public booking — CLOSED S593
- 17 Books, 18 Admin — CLOSED S592
- 19 PM companies — CLOSED S593
- 20 AI agents — CLOSED S593
- 21 Crons/scheduler — CLOSED S593
- 22 Surveys/notifications/appointments — CLOSED S593

**NEXT = Subsystem 23 — MH/RV** (`homeOwnership`, `homeSale`, `lotRent`, `propane`,
`dumpLocations`, `vehicles`, `depots`, `commonAreas`). Core to Oak Park (RV/MH park).
Then **24 — Work-trade / snowbird / recurring**, and the sweep is complete.

**Comb method (Nic-enforced):** BY HAND, one subsystem at a time, in order,
line-by-line — NO fan-out/workflow agents. AND run **both lenses**:
security/correctness *and* design-flow/efficiency/redundancy (Nic, S593 — I'd been
finding only bugs; he wants product-flow observations surfaced proactively, and
strategic redundancy flagged BEFORE combing for bugs).

---

## WHAT SHIPPED (code complete, NOT committed, all tests green)

### A. Subsystem combs — all CLEAN (evidence, not pattern-checked)
- **16 Storefront** — money path 100% server-derived (Stripe amount from `quoteStay`,
  advisory-lock + conflict re-check, idempotent confirm); file-serves per-row scoped +
  traversal-safe; `resolveProperty` hard-gates on `public_booking_enabled`. **2 bugs fixed:**
  (1) `apps/storefront/main.tsx` amenity card read snake_case off camelized responses
  (`reservation_fee`→`reservationFee`, `open_time`, `requires_approval`, `events_enabled`, etc.)
  → fees showed $0, hours/approval/events UI broken. (2) `guestBody` had no `.max()` on
  name/email/phone. **Added** `publicWriteLimiter` (8/15min/IP) on `/inquiry`, `/stay-link`,
  `/book` (skips under vitest).
- **19 PM companies** — `assertPmStaffRole` on every `/companies/:id/*` handler
  (count-reconciled), sub-resources scoped by `pm_company_id`, staff-invite `/accept`
  requires caller-email == invite (blocks token theft), Connect owner/manager-gated.
  **1 bug fixed:** `apps/pm-company` `AgentActivityPage.tsx` — entire page read snake_case
  (8 reads: `totals.tenant_count/escalated_count/avg_latency_ms`, `by_outcome/by_agent/by_tool`,
  `labelKey="agent_name"`) → all KPI tiles/breakdowns rendered 0/empty. Fixed + **ratcheted
  wireContract baseline pm-company 8→0**.
- **20 AI agents** — actor built server-side from JWT / verified booking token / synthetic
  prospect (never client body); **all 17 id-taking tools scope the LLM id to `actor`**;
  PII readers doubly-scoped `AND landlord_id=actor.profileId`; public agents rate-limited +
  restricted tool allow-lists. No bugs.
- **21 Crons** — money jobs idempotent (partial-unique indexes `ux_payments_*` + `ON CONFLICT
  DO NOTHING` + Stripe deterministic keys `auto_friday_<acct>_<day>`, `platform_passthrough_<intent>`
  + advisory locks); per-item try/catch in every money loop; scheduler wraps every callback
  (61 callbacks / 84 try-catch) so no unhandledRejection. No bugs.
- **22 Surveys/notif/appts** — notifications every read/write `WHERE user_id=req.user.userId`
  (no IDOR); surveys tenant-scoped via active-lease propertyIds + `ON CONFLICT (survey_id,
  tenant_id)` double-submit guard + response keyed to ctx.tenantId; appointments `business_id`-
  scoped; announcements = platform broadcasts. `/bulk` jsonb blob is server-built. No bugs.

### B. Listings marketplace (NEW feature — the long-term public channel)
Spun off the S16 photo-policy question. 3-tier funnel (Nic-locked):
- **Migration** `20260806130000` — `unit_applications.applicant_user_id`.
- **Backend** (`routes/properties.ts`): `GET /public/properties/listings/browse` (anon teaser —
  city/rent/specs + ≤3 photos, NO address/name/landlord); `GET /public/properties/listings`
  (requireAuth, **bg-check browse gate REMOVED**, full details, landlord contact stripped);
  `POST /public/properties/listings/:unitId/apply` (bg approved/waived only, **FREE**,
  files application + notifies landlord + reveals contact, idempotent); `GET /public/properties/
  listing-photo/:filename` (PUBLIC, only for `status='vacant' AND listed_vacant=TRUE` units).
- **Frontend** (`apps/listings/main.tsx`, full rewrite + Stripe deps + `.env`/`.env.production`):
  anon teaser → in-app **email-OTP** signup/login → tier-2 details → stateful **Apply** button
  (not-logged-in→signup; approved→file+reveal contact; unscreened→**in-app speculative bg-check**
  = name+pay+consent → Checkr hosted intake, reusable across listings; via `/api/background/*`).
- **Tests:** `listings-marketplace.test.ts` (9).
- **Decisions locked:** keep email-OTP 2FA for renters (bank+bg data); renter-initiated apply =
  FREE (the $1 stays on landlord-initiated pool reach-out only); unit listing photos are PUBLIC
  for listed vacancies (marketing images, no account needed).

### C. Two-channel defrag (design work from the S22 flow-review)
**Principle:** don't merge the two public channels (they serve different segments —
listings :3008 long-term vs booking storefront :3015 short-term/RV/storage). Unify the
DESTINATION: both converge on the **Master Schedule (single occupancy truth)** via the one
onboarding pipeline. Booking already did (long stay auto-drafts a lease); listings dead-ended.
- **Migration** `20260806140000` — `leases.source_application_id` (+ unique partial index) +
  `'application_draft'` added to `leases_lease_source_check`.
- **Service** `services/applicationLeaseDraft.ts` — `draftLeaseFromApplication` mirrors
  `maybeDraftLeaseFromBooking`: idempotent draft of a `pending`/`needs_review` `month_to_month`
  lease (rent from unit, start = move_in_date COALESCE CURRENT_DATE), landlord notified. No
  tenant link at draft (the e-sign flow attaches at sign time).
- **Endpoint** `POST /api/properties/applications/:id/onboard` (landlord action, scoped).
- **Control tower** — approved applications now appear in `/me/todos` onboarding (`type:'new_applicant'`,
  href `/applications`). `landlords.ts`.
- **Mode-consistency (real bug fixed):** booking availability checked ONLY `unit_bookings`.
  Now `hasConflict` (`services/propertyBooking.ts`) + `typeAvailability` (`publicPropertyBooking.ts`)
  also block bookings overlapping a lease with **`status IN ('active','pending')`** (matching the
  `scheduleCompression.rankUnitsBestFit` occupancy model; `end_date NULL` = open-ended). Listings
  side already excludes active-leased units (`units.status` flips off 'vacant' on esign activation).
- **Frontend:** `apps/landlord/pages/ApplicationsPage.tsx` (NEW, `/applications` route) — lists
  applicants + "Screened" badge + **Onboard** button → drafts lease → navigates to `/leases?open=`.
  Extended `GET /properties/applications` (bg status + `lease_drafted` flag).
- **Tests:** `applicationLeaseDraft.test.ts` (6) + 3 booking-respects-lease tests in
  `propertyBookingFlow.test.ts`.

### D. Memory hygiene (Nic-directed)
Memory is for **how-we-work rules + philosophies/concepts NOT in the code** — NOT product-feature
facts (those are readable from the code). Pruned **111→45 files**, MEMORY.md **19.8→6.6KB**.
Deleted all product-fact + old session/bug-sweep entries. Did NOT save honesty/transparency
(baked into every design point). Re-surfaced the standing rule: **don't hedge about session length**.

---

## TREE / VERIFY STATE
- Migrations `20260806130000` + `20260806140000` applied to `gam`; schema regenerated.
- tsc clean: api, landlord, listings, pm-company, storefront, shared.
- All session-touched suites green: **100+** (listings 9, applicationLeaseDraft 6, propertyBookingFlow 15,
  publicPropertyBooking 12, properties 41, properties-gap-close 32, landlords-todos 17, wireContract 15,
  pm portfolio/admin/etc. earlier).
- **Nothing committed.** Working tree holds the full uncommitted S578→S593 sweep.

## OPEN / DEFERRED
- **Listings frontend not live-smoked** — the OTP→payment→Checkr chain needs a running stack +
  email + Stripe + Checkr; reuses already-tested backend endpoints. Backend unit-tested; frontend
  tsc+build+shell-render verified in the in-app browser.
- **Deploy config:** `apps/listings` needs `VITE_STRIPE_PUBLISHABLE_KEY` at prod build (dev uses
  the API `testMode` path). `.env.production` has a documented placeholder.
- **Intentional asymmetry:** a *pending* draft lease keeps the unit in the listings marketplace
  (still `status='vacant'`, collect applications until one signs) but DOES block short-term bookings
  (conservative, avoid double-booking mid-onboarding).
- **PM-portal parity watch:** pm-company (:3011) = multi-owner/management-company overview ≈ the
  landlord overview + fee/payout flow; keep the overview flow shared, don't let it drift.

## NEXT SESSION
1. **Subsystem 23 — MH/RV** (in order). Both lenses (security + design-flow). Then 24.
2. Keep memory lean — do NOT re-save product-feature facts (read the code instead).

## RELEVANT MEMORIES
[[gam-sweep-byhand-no-fanout]], [[gam-comb-dual-lens]], [[gam-comb-thoroughly-no-overclaim]],
[[gam-defrag-two-public-channels]] (deleted per hygiene — captured here), [[gam-nothing-public-rule]],
[[gam-file-serve-perrow-auth]], [[gam-foreign-ref-write-scope]], [[gam-camelize-wire-contract-test-gap]],
[[feedback-no-session-length-hedging]].
