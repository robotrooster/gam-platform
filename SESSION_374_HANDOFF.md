# Session 374 — closed

## Theme

**Opened the tenants.ts arc** (1326 lines, NO TESTS —
largest remaining unwalked file). Slice 1 of N: profile +
dashboard + landlord-banking nudge + deposit-interest +
ACH verify (5 routes, ~300 LoC).

The slice surfaced **1 real production bug** —
`tenants.otp_qualified_at` column doesn't exist in the
schema, but `POST /verify-ach` writes to it. **Every
tenant ACH verification has been 500'ing in production.**
Fourth schema-drift bug in the sweep (S355 properties.ts,
S360 leaseFeesSync, S370 NACHA monitoring, now S374
tenants verify-ach).

The column appears to have been replaced by dynamic
qualification checks via `services/otp.getQualificationStatus`
(per S365's landlords-otp.ts wire-up) — the route was
half-migrated when the timestamp tracking was dropped from
the schema, but the route's UPDATE wasn't updated. Fixed
by removing the broken write; tenant ACH verify now only
flips `ach_verified` + `bank_last4`, and OTP qualification
is checked dynamically by the otp service.

12 new test cases pin the slice including the F1 fix.

Suite at S373 close: **1087 / 62 files**.
Suite at S374 close: **1099 / 63 files** (+12 cases, +1
file).

Zero tsc regressions, zero production regressions.

## Items shipped

### Bug fix (1)

**F1 — POST /tenants/verify-ach 500 on every call
(`otp_qualified_at` column doesn't exist)**
- `tenants.ts:295-338` — UPDATE statement referenced
  `otp_qualified_at = CASE WHEN ... THEN ... ELSE
  otp_qualified_at END` on the tenants table. Schema
  has `otp_disqualified_until` + `otp_disqualified_reason`
  (negative-case tracking) but no `otp_qualified_at`.
- Pre-fix: every verify-ach call crashed 500 with
  "column 'otp_qualified_at' does not exist." Tenant
  ACH verification flow was dead in production —
  blocking the OTP onboarding gate.
- Fix: dropped the broken UPDATE column + the response
  field. The route now sets `ach_verified=TRUE` +
  `bank_last4`. Qualification status is computed
  dynamically via the otp service (per S365
  `getQualificationStatus`). Response retains
  `deposit_fully_funded` so the frontend can show the
  right message.
- Bug class: schema-drift / route references column
  that doesn't exist. **4th instance in the sweep**
  (S355, S360, S370, S374). Worth a codebase-wide
  hygiene pass to catch any remaining.

### Test coverage — 12 cases / 5 describe blocks

New file: `apps/api/src/routes/tenants-profile-dashboard.test.ts`

**GET /me/landlord-banking-status (2)**
- Tenant with no active lease → ready:false (degenerate
  state shows the same UI as not-ready)
- Tenant with active lease + landlord Connect ready
  (`connect_payouts_enabled` + `connect_details_submitted`
  both true) → ready:true

**POST /me/nudge-landlord-banking (3)**
- Happy: fires `emailLandlordBankingNudge` mock with
  landlord/tenant/property context; returns 200
- Recent nudge in last 24h (seeded into
  `email_send_log` with `related_entity_type=
  'tenant_landlord_nudge'`) → 429 rate limit; email
  NOT fired
- Landlord banking already complete → 409 "no nudge
  needed"; email NOT fired

**GET /me (1)**
- Happy: full shape with property + unit + deposit
  summary; `deposit_fully_funded=true` when collected =
  total

**GET /me/deposit-interest (3)**
- No deposit → `{deposit:null, rate:null, accruals:[]}`;
  `getAccrualHistory` NOT called
- Statutory state (MA 2026, seeded inline matching prod
  migration) → `rate.source='statutory'` +
  `annual_rate_pct=5`; accruals from mocked service
- Non-statutory state (AK) with landlord override →
  `rate.source='landlord_override'`,
  `statute_citation=null`, rate from
  `landlord_deposit_interest_rate_overrides`

**POST /verify-ach (3)**
- Invalid last4 (not 4 chars) → 400
- **F1 regression pin:** deposit fully funded →
  ach_verified=true + qualified message; tenants row
  reflects ach_verified + bank_last4. Pre-fix this 500'd.
- Deposit NOT fully funded → ach_verified=true +
  activation-pending message

### Test infra additions

- Mocks for `services/email.emailLandlordBankingNudge` +
  `services/depositInterest.getAccrualHistory` (vi.hoisted
  pattern). No cleanup helper changes needed.

## Files touched

```
apps/api/src/routes/
  tenants.ts                              (+11 -9 lines: F1 fix)
  tenants-profile-dashboard.test.ts       (NEW — 305 lines, 12 cases)
```

No migrations. No schema changes. No frontend changes.
No cleanup helper changes.

## Decisions made during build

| Question | Decision |
|---|---|
| F1 fix posture: add the column via migration, or drop the route's reference? | **Drop the route's reference.** The schema has `otp_disqualified_until` for the negative case, and `services/otp.getQualificationStatus` for dynamic checks (per S365). Adding `otp_qualified_at` would duplicate the dynamic check with a stale-prone persisted timestamp. The bug is the route, not the schema. |
| Response shape change: keep `otp_qualified_at` in response as `null` always, or drop it? | **Drop it.** Returning a field that means nothing is worse than the breaking change. If the frontend reads it, it'll get undefined — clean signal that the field is gone. The `deposit_fully_funded` + `message` already convey OTP-readiness state. |
| F1 fix scope: also sweep other tenants.ts routes for similar drift? | **Surgical fix.** The other 35+ routes will be tested in subsequent slices — schema-drift bugs will surface as their slices land. Codebase-wide hygiene sweep is a separate hardening pass (already noted in deferred docket S370+). |
| Test the message text for both qualification paths (qualified vs activation-pending)? | **Yes.** The split message ("OTP qualified" vs "OTP will activate once your deposit is fully funded") is the only signal the frontend has about qualification state. Pinning both strings catches refactors that flip the conditional. |
| Test the GET /me happy path against multiple lease states? | **Single happy path.** The route returns the active-lease + deposit summary via a LATERAL JOIN; multi-state coverage would exercise the JOIN logic but the structural assertions (property_name, unit_id, deposit fields) already pin the JOIN. |
| Probe for column drift on the other 4 routes in this slice (landlord-banking-status, nudge, /me, /deposit-interest)? | **Implicitly probed via happy-path tests.** All four ran successfully with seeded data; their SELECT/UPDATE statements would have crashed on any missing-column reference. The verify-ach bug surfaced because seeded data triggered the UPDATE branch that referenced the broken column. |

## Verification

- `npx tsc --noEmit` clean on apps/api (0 errors).
- `npm test` in apps/api: **1099 tests across 63 files, 0
  failures**, ~537s.
- 12 new test cases (`tenants-profile-dashboard.test.ts`).
- 1 production bug fix (`tenants.ts` F1 — otp_qualified_at
  column).
- 0 production regressions.

No frontend touched, no shared-package touched.

## Items deferred — what S375 could target

### tenants.ts remaining slices (~35 routes left)

S374 covered 5 of tenants.ts's 40 routes (~12.5%).
Remaining surfaces:

- **FlexCharge** (2 routes) — list + dispute
- **FlexPay** (5 routes) — list + enroll + terms +
  re-acceptance flow + delete
- **FlexDeposit** (6 routes) — list + retry-acceleration
  + enroll + terms + portability eligibility/authorize/
  decline + delete
- **OTP/credit enrollment** (2 routes)
- **Payments history** (1 route)
- **Invite + accept-invite + invite-info** (3 routes)
- **Admin-facing /:id/profile + /:id/transfer + /:id/available-units** (3 routes)
- **Profile patch + avatar + password** (4 routes)
- **Lease views** (3 routes)
- **Work-trade + charge-account** (2 routes)

Recommended next slice: FlexCharge + FlexPay + FlexDeposit
(13 routes — closes the FlexSuite tenant-side surface).

### **NEXT FRESH-CONTEXT SESSION:** Checkr API wire-up

Memory note `project_checkr_access_unblocked.md` is the
priority. Nic obtained Checkr Partner credentials
2026-05-26. The next fresh-context session starts with
wiring `background.ts` to live Checkr.

### Architectural / non-test (carried)

- **Unicode-capable font in flexsuitePdf** — open since
  S333.
- **responsibleParty source-comment drift fix** —
  one-liner.

### Hardening flagged

- **action.url scheme validation in adminNotifications**
- **logAdminAction targetId-uuid audit** (codebase-wide)
- **silent-failure pattern audit** (try/catch swallow)
- **schema-drift audit** — now 4 instances (S355,
  S360, S370, S374). Worth dedicating a session to a
  codebase-wide grep for SQL columns that don't exist in
  the current schema. The pattern is consistent: routes
  reference columns that got dropped or renamed, latent
  because the surface is unwalked.
- **arc-completeness verification at close time** —
  surfaced S373

### Vendor-blocked / walkthrough-blocked / dev-team scope

(All unchanged from S373.)

## Items deferred (cross-session docket, post-S374)

- Consumer-side retention framing decision (S300) — Nic-pending
- Campground Master import path — Nic-blocked on sample
- 2FA fan-out — walkthrough-blocked
- Yardi GL-export columns, Rentec template (S293) — vendor-blocked
- FlexCharge Business Account Agreement signature capture (S309 option B)
- FlexDeposit eligibility-check workflow (S309 option C)
- Standalone POS-operator auth (S309 option D)
- Deposit-return ↔ unpaid-installment offset architecture call — Nic-pending
- SchedulePage booking-vs-lease shape audit — walkthrough-blocked
- Embed Unicode-capable font in flexsuitePdf — open architectural pick
- Credit-score formula + recompute test coverage — locked v1.0.0
- Visual review of reconstructed PmInvitationsPage — walkthrough-blocked
- posTerminal service tests (Stripe-boundary, low marginal yield)
- action.url scheme validation (defense-in-depth, no live risk)
- pm.ts remaining slices: property invitations / Connect / payouts / drilldown
- units.ts remaining: /:id/economics / /:id/eviction-mode (walkthrough-blocked)
- properties.ts remaining: units/bulk + photos + listings + apply + applications
- logAdminAction targetId-uuid audit (codebase-wide hygiene pass)
- silent-failure pattern audit (try/catch swallow class)
- **schema-drift audit (4 instances now: S355/S360/S370/S374) — codebase-wide grep priority**
- arc-completeness verification at close time (process hardening)
- tenants.ts remaining: FlexCharge + FlexPay + FlexDeposit + OTP/credit + payments history + invite/accept + admin /:id/* + profile-patch/avatar/password + lease views + work-trade + charge-account
- **NEXT FRESH-CONTEXT SESSION:** Wire background.ts → Checkr API (credentials in hand 2026-05-26)

## Nic-pending (unchanged minus Checkr)

- Stripe live keys + production webhook URL registered
- Resend domain verification
- Plaid production keys
- Stripe Terminal hardware
- ~~Checkr Partner credentials~~ — UNBLOCKED 2026-05-26
- Consumer-side retention framing decision (S300)
- FlexCredit Lender partner selection
- SLA § 9.1.4(iii) deposit-return offset framing call

## What S375 should target

After S374:
- Cumulative sweep: 28 sessions, ~358 route-level tests,
  19 production bugs caught + fixed

**Continue tenants.ts arc.** Next slice: FlexCharge +
FlexPay + FlexDeposit (~13 routes — closes the FlexSuite
tenant-side surface). Mock the flexCharge / flexpay /
flexdeposit services; test the route contract.

The schema-drift pattern has now hit 4 times. The S375
slice will likely surface a 5th instance if any of the
flex routes reference dropped columns. Worth being
explicit about probing on first run.

If clearing for fresh context: per memory note, start
S375 with the **Checkr API integration in background.ts**
before returning to the test sweep.

---

End of S374 handoff. tenants.ts arc opened — slice 1 of
N covered (profile + dashboard + landlord-banking nudge
+ deposit-interest + verify-ach). 1099 tests / 63 files
/ 0 failures. **4th schema-drift bug caught** — every
tenant ACH verification was crashing 500 in production.
