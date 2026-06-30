# SESSION 516 HANDOFF

Theme: **Continued the `WALKTHROUGH_CHANGES.md` sweep** after S515's "save for
shutdown" — Nic said keep going. Shipped 6 more substantive items + locked all
remaining product calls. All work uncommitted (Nic decides commits). **4
migrations applied this session, all 2026-06-26**, schema.sql regen'd each time.
Everything builds green; new/changed suites pass. Walkthrough now **93 [x] / 15
[~] / 5 [ ]**.

> NOTE: S515 handoff covers the amenity-reservations + outage-broadcast features
> and the first walkthrough batch. THIS file covers only the post-S515 work.

---

## Shipped this session (all green, with tests)

### POS #1 — business-level margin + auto-pricing
- Migration `20260626120000_pos_default_margin.sql`: `landlords.pos_default_margin_pct`
  (CHECK 0–<100). `GET/PATCH /api/pos/settings` (routes/pos.ts).
- POSPage.tsx: "Default margin %" setter on the Add-Item card; per-item Cost→Margin→Sell
  two-way auto-pricing (sell = cost/(1−margin/100)); override-confirm when an item's margin
  deviates >0.5% from the business default. 1 endpoint test (in pos.test.ts). POS tsc+build green.

### PM Company #3 — self-register model C (dev auto-verify)
- routes/auth.ts `/register`: when `NODE_ENV` is not 'production' AND not 'test', the new user is
  `email_verified=true` immediately + the verify email is skipped. Prod still gates; 'test' keeps the
  real gate so emailVerification suites stay honest. 1 new test (47 auth/email-verify tests green).

### Landlord #23 — agent asks once about the remote/guided inspection
- Migration `20260626130000_inspection_guided_walkthrough_declined.sql`:
  `unit_inspections.guided_walkthrough_declined` (+ _at).
- New tenant tool `services/agents/tools/declineGuidedInspection.ts` (records the decline, tenant-
  scoped, idempotent); registered in tools/index.ts + on both tenant allowlists (profiles.ts).
- `getInspectionChecklist` now returns `guidedWalkthroughDeclined`; `TENANT_INSPECTION_ROUTING`
  prompt: offer at most once, decline on a no, never re-offer when the flag is set. 3 new tests
  (115 tools tests green; registry-wiring assertion passes).

### Platform #1 — centralized the @gam/shared alias (portability)
- New `packages/shared/viteSharedAlias.mjs` (resolves `./src/index.ts` via `import.meta.url` —
  portable, never the CJS dist). All 10 app vite configs now `import { sharedAlias }` instead of
  hardcoding `/Users/nicholasrhoades/...`. All 10 `vite build`s green. (Old absolute paths were a
  real CI/deploy landmine.) Stale `.js` config dupes (admin/landlord/pos/tenant) left inert.

### Tenant #6 — 48h move-in inspection gate (Nic spec)
- Spec (Nic): inspection must complete within 48h of lease start; miss → lose access + assume
  liability for undocumented issues.
- Migration `20260626140000_move_in_inspection_deadline.sql`:
  `unit_inspections.move_in_deadline_missed_at`.
- `GET /api/tenants/me/move-in-gate` (routes/tenants.ts): deadline = lease.start_date + 48h; a still-
  draft move-in inspection past it → `gated:true` + stamps the liability moment (idempotent). Gate
  only fires when a draft move-in inspection EXISTS (never lock out for the landlord's omission).
- Tenant portal `Layout` renders a full-page `MoveInLockout` in place of all routes EXCEPT
  `/inspections*` (the one allowed action). 4 endpoint tests; tenant tsc+build green.

### Amenities #4 — reservation-fee charging + demand pricing + refund (Nic spec)
- Spec (Nic): charge on-platform (all money through GAM), landlord-set pricing incl. weekend demand
  pricing, refundable ≥48h before.
- Migration `20260626150000_amenity_fee_charging.sql`: `common_areas.weekend_fee`;
  `common_area_reservations.fee_payment_id` / `fee_refund_due` / `fee_voided`.
- services/commonAreas.ts: `computeReservationFee` (Fri/Sat/Sun → weekend_fee), `billReservationFee`
  (on go-live, via existing `createLeaseFeePayment` → a `type='fee' fee_type=amenity_fee` payment the
  tenant pays through the normal Stripe rails — NO bespoke charge code), `settleReservationFeeOnCancel`
  (≥48h → void unpaid / flag-refund paid + notify landlord; <48h → fee stands).
- routes/commonAreas.ts: weekend-aware fee at request; bill on auto-approve + landlord-approve; refund
  policy + `amenity_fee_refund_due` notification on cancel. Landlord AmenitiesPage: "Weekend fee" field
  + card display. 4 new tests (13 common-area tests green); API tsc + landlord build green.

## Walkthrough reconciliation / decisions (no code)
- Fitness (6 items) → NOT a launch feature; already `LAUNCH_HIDE_FITNESS`-hidden in landlord+tenant,
  no admin surface. Marked deferred.
- Operations #1 (done earlier), #2/#3 deferred (units endpoint / FlexSuite hidden). Admin #6, Admin&Ops
  #1, Landlord #14, #32 all resolved earlier (see S515 + file).

## Product calls LOCKED this session (specs in WALKTHROUGH_CHANGES.md) — ready to build
- **Landlord #2 (work-trade billing)** — THE remaining buildable feature. Rent traded as a PERCENT of
  hours worked. Monthly hours target at the **property level** (default 80 → 1 verified hr = 1/target
  of invoice, ~1.25%/hr). Credit subtracts from the **TOTAL invoice (rent + utilities + fees)**, not
  just base rent. Hours from a **time clock** (tenant submits, landlord verifies; only verified hours
  credit). NOT yet built — next session's single focus.
- **Landlord #11 (waitlist)** — spec locked (public guests, notify-next-on-cancel, **1-hour** claim
  window). BLOCKED: no public unit-booking surface exists today (`unit_bookings` staff-only;
  publicBooking.ts is service-business appointments). Needs the public unit-booking site built first.
- **Landlord #10 (Master Schedule)** — dedicated session; Nic will walk through the broken layout.
- **Listings #1 + #31 (prospect screening)** — TWO flows, both via Checkr → applicant pool: (A) apply
  to a specific property, (B) general "find a place" with no property. Dedicated build.
- **Amenities #4** — built this session (see above).

## SHUTDOWN STATE
- 4 migrations applied this session (all 2026-06-26): pos_default_margin, inspection_guided_walkthrough
  _declined, move_in_inspection_deadline, amenity_fee_charging. schema.sql regen'd.
- API tsc clean; landlord/tenant/pos + all 10 vite builds green.
- New test coverage green: pos.test.ts (+1), emailVerification (+1, 13), tools.test.ts (115),
  tenants-profile-dashboard.test.ts (18: payment-health + move-in-gate), commonAreas.test.ts (13).
- No half-finished edits.

## What next session should target
1. **Landlord #2 (work-trade billing)** — the spec is locked above; build it fresh with full context.
   Touch points: a property-level monthly-hours-target field, a time-clock entries table (tenant
   submit → landlord verify), and the credit applied across the full invoice (rent+utilities+fees) at
   invoice generation. This is multi-part — give it a whole session.
2. Then the dedicated-session items: public unit booking + #11 waitlist; Master Schedule #10 (with
   Nic); prospect screening (#31 + Listings #1, both flows).
3. Vendor-gated tail: Outages SMS (Twilio), Property-Intel #1 (data, "later").

## How to resume
- `~/gam-start.sh` boots everything. Logins/ports per CLAUDE.md.
- Re-run this session's suites: `cd apps/api && npx vitest run src/routes/pos.test.ts
  src/routes/emailVerification.test.ts src/services/agents/tools/tools.test.ts
  src/routes/tenants-profile-dashboard.test.ts src/routes/commonAreas.test.ts`
- New surfaces: POS Add-Item default-margin + auto-pricing; tenant 48h move-in lockout; landlord
  Amenities weekend-fee; agent decline-guided-inspection. All app builds use the new shared alias.
