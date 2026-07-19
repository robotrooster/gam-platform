# SESSION 541 HANDOFF

## Theme
FlexPay turned ON behind a demand-test gate (Nic-locked): tenant-portal
ONLY, inquiry → GAM review (lease + SSI/SSDI income verify) → approval →
enrollment. Controls float (the engine FRONTS rent each cycle — every
enrollment is bankroll), measures demand for a possible capital raise.
FlexPay ~40-50% of GAM revenue at scale (Nic).

## Shipped (api+tenant+admin tsc clean; 19/19 tests; tenant flow verified live)

### 1. Schema + shared
- Migration 20260714210000 (applied): `flexpay_inquiries` — one row
  per tenant (UNIQUE), status pending/approved/declined,
  claimed_income_source ssi/ssdi, tenant_note, admin_notes,
  reviewed_by/at.
- shared: FLEXPAY_INQUIRY_STATUS_VALUES/_LABEL, FLEXPAY_INCOME_SOURCE_VALUES.

### 2. API
- POST /api/tenants/flexpay/inquiry — tenant-only, visible-gated,
  409 on duplicate; fires an admin notification (category
  flexpay_inquiry).
- GET /api/tenants/flexpay now returns `inquiry`.
- GET /api/tenants/flex-visibility — per-product rollout flags for the
  tenant UI.
- **enrollFlexPay server gate** (services/flexpay.ts): no approved
  inquiry → refuse; checked BEFORE eligibility so a pending tenant
  sees "under review" (their ssi_ssdi is set BY the approval).
- Admin: GET /api/admin/flexpay/inquiries (lease/rent/property context
  joined via active-lease LATERAL; pending first) + POST
  /api/admin/flexpay/inquiries/:id/review — approve REQUIRES
  incomeVerified:true (422 otherwise) and sets tenants.ssi_ssdi;
  decline takes notes; both audit via logAdminAction
  (flexpay_inquiry_approved/_declined). Declined rows can be
  re-reviewed (Re-review button → approve modal).

### 3. Tenant portal (the ONLY FlexPay surface)
- /services (Flex Advantage) is now PER-PRODUCT FLAG-DRIVEN
  (useFlexVisibility → /tenants/flex-visibility): '/services' left
  LAUNCH_HIDDEN; nav link + dashboard Subscriptions card + deposit-KPI
  framing + page cards all keyed to flags. With only flexpay ON the
  hub shows exactly one card. No flags on → nav hidden, /services
  redirects home.
- FlexPay card states: no inquiry → "I'm interested" →
  FlexPayInquireModal (SSI/SSDI toggle + optional note; no ACH gate —
  interest is low-friction); pending → "Request received" badge;
  declined → "Not available right now"; approved → Enroll (ACH-gated)
  → existing FlexPayModal.
- Verified live as alice@tenant.dev: only FlexPay card, inquiry
  submitted through the modal, card flipped to Request received.
  **Alice's pending inquiry is LEFT IN the dev DB** — first real row
  for Nic to approve from the admin queue.

### 4. Admin portal
- New nav "⚡ FlexPay Requests" → /flexpay-requests: pending/decided
  tables (tenant, property/unit, rent = the float being approved,
  claimed source, income-verified + ACH badges, tenant note), review
  modal with REQUIRED income-verified checkbox on approve, float
  warning banner + review checklist.
- NOT walked live: admin login needs Nic's TOTP. Backend proven by
  tests; page follows the DepositPortability pattern exactly.

### 5. Flag flip
- system_features.flexpay_rollout_visible = TRUE (dev DB).
  flexdeposit/flexcredit/flexcharge remain FALSE.
- Verified: zero FlexPay references in apps/landlord/src and the live
  marketing HTML.

### 6. Tests — s541-flexpay-inquiry.test.ts (3 cases, real service)
inquiry create + dup 409 + GET carries it; enroll blocked pending AND
declined; approve without attestation 422; approve sets ssi_ssdi and
unlocks enroll (fee $8 = $5+day3); role guards. Plus
tenants-flex.test.ts still green (16 cases).

## Decisions
- Nic: FlexPay tenant-portal only; inquiry-then-approval demand test;
  controls bankroll; inquiry volume gauges whether to raise capital.
- Claude (flag if wrong): inquiry has NO ACH/eligibility precheck
  (interest should be low-friction); approve REQUIRES the
  income-verified attestation and doubles as setting ssi_ssdi;
  declined tenants can be re-reviewed; one inquiry row per tenant.
- CLAUDE.md FlexPay section corrected: "no advance" was legal framing —
  the engine fronts rent (S541 note added). Memory:
  flexpay-demand-test-rollout.md.

## Files touched
api: migrations/20260714210000_flexpay_inquiries.sql (applied),
services/flexpay.ts (gate), routes/tenants.ts (+inquiry,
+flex-visibility, GET extend), routes/admin.ts (+2 routes, +zod import),
routes/s541-flexpay-inquiry.test.ts (new).
shared: index.ts (inquiry enums).
tenant: main.tsx (useFlexVisibility, flag-driven nav/dashboard/hub,
FlexPay card states, FlexPayInquireModal).
admin: main.tsx (nav, route, FlexPayRequests page).
CLAUDE.md (FlexPay S541 note).

## Next session targets
1. Nic: approve alice's pending inquiry from Admin → FlexPay Requests
   (first live run of the queue; needs his TOTP).
2. When Stripe live keys land: S520 flip procedure — actual pulls +
   fronting go live; enrollment before that works but moves dev-mode
   money only.
3. Possible polish: email the tenant on approve/decline (currently
   in-app card state only); inquiry-volume counter on admin Overview.
4. Unchanged queue: storefront subdomains; Checkr key; DoorLoop
   export; fee-number blessings.

## Watchouts
- The demand gate is server-side in enrollFlexPay — do NOT remove
  without Nic (that's the max-rollout decision).
- tenants-flex.test.ts mocks enrollFlexPay, so it does NOT exercise
  the inquiry gate — s541-flexpay-inquiry.test.ts does (real service).
- OTP/FlexPay double-front dedup unchanged (OTP wins the front when
  both active) — the gate sits in front of enrollment only.
