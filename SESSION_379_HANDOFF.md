# Session 379 — closed

## Theme

tenants.ts arc continues. **Slice 6 of N:** admin-facing
/:id/* routes — GET /:id/profile (large aggregation) +
POST /:id/transfer (501 stub) + GET /:id/available-units
(3 routes).

The slice surfaced **1 production bug** — a schema-drift in
the /:id/profile lifetime-stats aggregation: lateCount was
filtering `payments.status='late'` but the
payments_status_check enum has no 'late' value, so the
filter was permanently 0. Fixed in the same pass; sourced
from `tenants.late_payment_count` (maintained by the
daily late-fee scheduler).

13 new test cases pin the slice + the fix.

Suite at S378 close: **1149 / 67 files**.
Suite at S379 close: **1162 / 68 files** (+13 cases, +1 file).
Runtime ~540s.

Zero tsc regressions, zero production regressions.

## Bug found + fixed

### lateCount filter on a non-existent enum value

**Symptom:** `tenants.ts:1050` (pre-fix) read:
```sql
COUNT(*) FILTER (WHERE status = 'late') as late,
```
…against `payments`, whose `payments_status_check` enum is
`['pending', 'processing', 'settled', 'failed', 'returned',
'paid_via_deposit']` — **no 'late'**. The FILTER never
matched any row, so the `lateCount` field in the /:id/profile
response was always 0, regardless of how many late-fee
events the tenant accumulated.

The real source for this metric is
`tenants.late_payment_count`, an integer counter incremented
by `jobs/scheduler.ts:1038` whenever a payment goes overdue
in the daily late-fee processor. Several other consumers
already use this column correctly (admin.ts:323 surfaces it
in the admin-tenant-list, email.ts:640 takes it as
`lateCount` for landlord-late-tenant notifications).

The route already SELECTs the tenant row via `SELECT t.*`
at line 996 — so `tenant.late_payment_count` is in scope
with no extra query.

**Fix:**
- Removed the dead `COUNT(*) FILTER (WHERE status='late')
  as late` line from the paymentStats SQL.
- Changed `lateCount: parseInt(paymentStats?.late || 0)` →
  `lateCount: tenant.late_payment_count ?? 0`.
- Added a comment on the paymentStats query noting why
  lateCount sources from `tenants.late_payment_count`
  instead of a payments filter.

Net diff: 5 lines in tenants.ts (one SQL line removed, one
JS line changed, one comment added).

**Test pin:** new test "lateCount sources from
tenants.late_payment_count, NOT a payments filter" updates
the column to 4 and asserts the response surfaces 4 — would
have failed on the pre-fix code (it returned 0 regardless).

This is the **second schema-drift bug found in the
tenants.ts arc** (S377 surfaced the `require('bcrypt')`
typo and the `requireAuth` mis-gate on public invite
routes). Still indicates the schema-drift audit listed in
the carried hardening docket is high-yield.

## Items shipped

### Test coverage — 13 cases / 3 describe blocks

New file: `apps/api/src/routes/tenants-admin-views.test.ts`
(289 lines)

**GET /:id/profile — 7 cases**
- Unknown tenant id → 404
- Unrelated landlord (no lease_tenants chain) → 403
- Tenant viewing themselves (isSelf branch) → 200
- Admin viewing any tenant → 200
- Landlord with a lease_tenants relationship → 200; units
  aggregation surfaces is_current=true
- Happy aggregation: payments + maintenance + stats with
  2 settled + 1 failed payment + 1 maintenance request;
  pins totalPayments=3, settledCount=2, failedCount=1,
  totalPaid=2100, avgPayment=1050, onTimeRate=67,
  unitsOccupied=1, maintenanceCount=1
- lateCount fix verification: column set to 4 → response
  surfaces 4

**POST /:id/transfer — 2 cases**
- Non-permitted role (tenant) → 403 from requirePerm
  ('tenants.archive') gate
- Permitted role (landlord = OWNER_ROLES auto-pass) →
  501 with retired-endpoint message + /e-sign/ reference

**GET /:id/available-units — 4 cases**
- Non-permitted role → 403
- Landlord with no vacant units → 200 empty
- Landlord with mixed units: seed one vacant-no-lease and
  one vacant-with-pending-lease; only the no-lease unit
  appears (NOT EXISTS guard)
- Admin caller with null profileId → 200 empty (the SQL
  filter `u.landlord_id = $1` matches nothing — admins
  have no profileId binding)

### Test infra

- Single `seedPortfolio()` helper builds the full chain
  (landlord + property + unit + tenant + lease + lease_tenants
  + admin user) and mints 3 tokens (landlord, tenant,
  admin) in one transaction. Reduces test setup boilerplate.

## Files touched

```
apps/api/src/routes/
  tenants.ts                    (MODIFIED — lateCount
                                 schema-drift fix)
  tenants-admin-views.test.ts   (NEW — 289 lines, 13 cases)
```

No migrations. No schema changes. No frontend touched.

## Decisions made during build

| Question | Decision |
|---|---|
| Fix the lateCount filter or leave it documented? | **Fixed in pass.** Per fix-it-right: we touched the route's test surface, the bug is a clear schema-drift (filter on a non-existent enum value), the correct source is already in scope (`tenant.late_payment_count` from the existing SELECT t.*), and the fix is 5 lines. Documenting an always-0 field instead of fixing it would leave a footgun. |
| Test the admin null-profileId branch on /:id/available-units? | **Yes.** Returning empty for admin callers is the current behavior (because the SQL filters by landlord_id = profileId). Pinning the branch documents the limitation — admins can't currently use this endpoint as-is. Worth knowing during a future product call on whether admins should see all-landlord vacant units. |
| Test the requirePerm + OWNER_ROLES interaction on the gated routes? | **Yes — both gates.** A tenant role hits the 403 (no permission); a landlord role auto-passes (OWNER_ROLES bypass) and reaches the route body (501 for transfer, real query for available-units). This is the matrix that proves the gate works in both directions without hardcoding role checks in the route. |
| Test the multi-landlord history case (tenant has had leases with multiple landlords)? | **Skipped — single-landlord case covers the contract.** The DISTINCT landlord_id query at line 1010 is straightforward; multi-landlord just adds more rows to the IN-check. The authz logic is `.some(canAccessLandlordResource)` which is structurally OR — pinning one matching landlord proves the branch. |
| Pin the onTimeRate calculation explicitly (settled / total = 67% for 2/3)? | **Yes.** The Math.round at line 1083 is the kind of thing that quietly drifts during refactors. A concrete 67% assertion catches off-by-one and rounding-direction bugs. |

## Observations (not bugs, not test targets)

### A. /:id/profile error message on no-tenant 404

The 404 reads "Tenant not found" — clear and correct. Worth
noting for the /:id/* slice that the error vocabulary is
consistent (vs. the /lease slice's "No active unit" which
S378 flagged as mildly misleading).

### B. /:id/profile aggregation is not paginated

`payments LIMIT 36`, `maintenance LIMIT 20`, `units` no
limit. For tenants with long history (eviction-history
scenarios, decade-long leases), the units query could
return 50+ rows. No pagination here. Pre-launch
acceptable; flag for the eventual scale review.

### C. /:id/available-units only returns the calling
landlord's units

The SQL filter `u.landlord_id = $1` where `$1 =
req.user!.profileId` means admin callers (profileId=null)
get [], and one landlord can't see another's vacant units.
This is correct per the multi-landlord trust boundary, but
caps admin utility. If an admin needs to see vacant units
for landlord-X to facilitate a tenant transfer, this
endpoint can't help them today. Product call on whether
to expose an admin-override version.

## Verification

- `npx tsc --noEmit` clean on apps/api (0 errors).
- `npm test` in apps/api: **1162 tests across 68 files, 0
  failures**, 539.75s.
- 13 new test cases (`tenants-admin-views.test.ts`).
- **1 production bug fix** (lateCount schema-drift).
- 0 production regressions.

The 58 tenants.ts tests from slices 1–5 (`tenants-profile-
dashboard.test.ts` 13, `tenants-flex.test.ts` 16,
`tenants-actions.test.ts` 9, `tenants-invite.test.ts` 15,
`tenants-lease.test.ts` 10) all continued to pass.

## Items deferred — what S380 could target

### tenants.ts remaining slices (~8 routes left)

S374 + S375 + S376 + S377 + S378 + S379 covered 32 of
tenants.ts's 40 routes (~80%). Remaining:

- **Profile patch + avatar POST + avatar GET +
  password** (4 routes — tenant self-edit)
- **Work-trade + charge-account** (2 routes — read-only
  status views)
- **/avatar-files/:filename** (1 route — static-ish
  multer-served asset)

Two more slices to close tenants.ts:
- Slice 7: tenant self-edit (4 routes, multer setup
  required for avatar POST tests)
- Slice 8: work-trade + charge-account + /avatar-files/*
  (3 routes — closes the arc)

**Recommend slice 7 (tenant self-edit) for S380.** Multer
setup is one-time cost; avatar upload paths historically
hide path-traversal and permission bugs, which is high
bug-yield surface.

### Per Nic's directive: "we need to finish all the portals"

S380–S381 close tenants.ts. Then the path forward:

- Audit pass across all routes/*.ts (one session) to
  enumerate test coverage per file — generates a
  prioritized worklist for the cross-portal sweep.
- Then arc through landlords.ts, pm.ts, properties.ts,
  esign.ts, payments.ts, maintenance.ts, books.ts, pos.ts,
  admin.ts, admin-ops.ts in whatever order the audit
  prioritizes (bug yield × surface area).

### Pending from prior sessions (carried)

- **FlexCredit ↔ rent-reporting product naming** (S376)
  — Nic-pending
- **Invite token leakage / column overload / expiry**
  (S377) — Nic-pending
- **Route-test coverage audit across all portals** (S378)
  — to run after tenants.ts closes

### **NEXT FRESH-CONTEXT SESSION:** Checkr API wire-up

Unchanged from S375–S378. Memory note
`project_checkr_access_unblocked.md`. Slice 1 recon done
in S376's opener.

### Architectural / non-test (carried)

- **Unicode-capable font in flexsuitePdf**
- **responsibleParty source-comment drift fix**

### Hardening flagged (carried + updated yield)

- **logAdminAction targetId-uuid audit**
- **silent-failure pattern audit**
- **schema-drift audit** — now **5 instances**
  (S355/S360/S370/S374 + S379-lateCount). Worth a
  dedicated session — every slice through a non-trivial
  route surfaces one of these.
- **arc-completeness verification at close time**

### Vendor-blocked / walkthrough-blocked / dev-team scope

(All unchanged from S378.)

## Items deferred (cross-session docket, post-S379)

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
- schema-drift audit (5 instances — codebase-wide grep priority)
- arc-completeness verification at close time (process hardening)
- tenants.ts remaining: profile-patch/avatar/password + work-trade
  + charge-account + /avatar-files/*
- **(S376)** FlexCredit ↔ rent-reporting product naming —
  Nic-pending resolution
- **(S377)** Invite token leakage / column overload / expiry —
  Nic-pending
- **(S378)** Route-test coverage audit across all portals —
  schedule after tenants.ts closes
- **(S379-new)** /:id/profile aggregation pagination — flag
  for scale review (units no LIMIT)
- **(S379-new)** /:id/available-units admin-override —
  product call on whether admins should see all-landlord
  vacant units
- **NEXT FRESH-CONTEXT SESSION:** Wire background.ts → Checkr
  API (credentials in hand 2026-05-26)

## Nic-pending

- Stripe live keys + production webhook URL registered
- Resend domain verification
- Plaid production keys
- Stripe Terminal hardware
- Consumer-side retention framing decision (S300)
- FlexCredit Lender partner selection
- SLA § 9.1.4(iii) deposit-return offset framing call
- **(S376)** FlexCredit vs. rent-reporting product disambiguation
- **(S377)** Invite token leakage / column overload / expiry posture

## What S380 should target

**Recommended path:** tenants.ts slice 7 — tenant self-edit
(profile patch + avatar POST + avatar GET + password). 4
routes; multer setup is the main new piece. Avatar upload
historically a high bug-yield surface (path traversal,
permission gaps, MIME validation). ~10-12 tests.

After slice 7 + slice 8, tenants.ts arc is fully closed.
Then run the route-test coverage audit before picking the
next portal.

---

End of S379 handoff. tenants.ts arc slice 6 of N covered
(3 admin-facing /:id/* routes). **1 schema-drift bug fixed
(lateCount filter on non-existent enum value).** 1162 tests
/ 68 files / 0 failures. Two more slices to close tenants.ts.
