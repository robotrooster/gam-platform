# Session 378 — closed

## Theme

tenants.ts arc continues. **Slice 5 of N:** lease views —
GET /lease + POST /lease/sign (410) + GET /lease/addendums
(the tenant's primary self-service lease surface, 3 routes).

The slice surfaced **0 production bugs**. All three routes
honor their contracts cleanly; the cross-lease isolation
filter on the addendums route holds under probe.

10 new test cases pin the slice.

Suite at S377 close: **1139 / 66 files**.
Suite at S378 close: **1149 / 67 files** (+10 cases, +1
file).
Runtime ~611s.

Zero tsc regressions, zero production regressions.

## Items shipped

### Test coverage — 10 cases / 3 describe blocks

New file: `apps/api/src/routes/tenants-lease.test.ts` (322 lines)

**GET /lease — 4 cases**
- no tenants row for the caller's userId → 404 "Tenant not
  found" (verifies the first guard)
- tenant exists but no active lease_tenants attachment → 404
  "No active unit" (verifies the unit-join guard)
- happy: returns lease detail with property_name +
  unit_number + landlord_name populated correctly
- pending-only lease still 404s "No active unit": the route
  joins on `l.status='active'` for the unit lookup before
  the (looser) `status IN ('pending','active')` SELECT, so
  a pending-only lease never surfaces. Pins this
  asymmetric branch.

**POST /lease/sign — 1 case (deprecated S20)**
- 410 with `/no longer supported/i` AND `/e-sign/i` in error
  message; body is ignored

**GET /lease/addendums — 5 cases**
- no tenants row → 404 (parity with /lease first guard)
- tenant with no active lease → 200 empty array (NOT 404 —
  asymmetry vs /lease is intentional, addendums is a
  history view)
- happy single addendum: returns changes + pdf_filename +
  resolved actor name; resolveAddendumActor called with
  `(recordedByUserId, landlordId)`
- multiple addendums: DESC by occurred_at (newer first)
- addendum for a DIFFERENT lease_id is excluded: filter on
  `event_data->>'lease_id' = $2` confirmed by seeding two
  events for the same tenant under two different
  lease_ids, expecting only the active one to surface

### Test infra

- 1 service mock: `resolveAddendumActor` (vi.hoisted).
  Default returns `{name: 'Test Landlord', role: 'owner'}`
  so single-actor cases don't need per-test setup.
- 1 helper: `insertAddendumEvent` — writes raw INSERTs
  into credit_subjects + credit_events with placeholder
  random-bytes this_hash. Hash chain integrity isn't
  validated by the consumer route, so this is acceptable
  for slice scope (the creditLedger.appendEvent path is
  tested in its own suite).

## Files touched

```
apps/api/src/routes/
  tenants-lease.test.ts   (NEW — 322 lines, 10 cases)
```

No production code touched. No migrations. No schema changes.
No frontend touched.

## Decisions made during build

| Question | Decision |
|---|---|
| Use the real creditLedger `appendEvent` to seed addendum events, or raw INSERTs into credit_subjects/credit_events? | **Raw INSERTs.** The consumer route does no hash-chain validation — it filters by subject_id + event_type + event_data->>'lease_id' and renders the payload. Calling appendEvent would couple this test to the credit-ledger chaining + dimension-tag enum + network-visibility enum, which all already have their own coverage in `creditLedger.test.ts`. Raw INSERTs keep the slice focused on the route contract. |
| Test the co-tenant tenant_name asymmetry (v_unit_occupancy returns the PRIMARY tenant's name even when called by a co-tenant)? | **Skipped — it's documented behavior, not a contract worth pinning.** Worth a UX note (see below) but not a slice test. |
| Test for the "no active unit" error message being misleading? | **Pinned the status code and branch, not the copy.** The message reads "No active unit" but really means "you don't have an active lease tenancy" — could mislead a support investigation. Pre-launch UX nit, not a test target. |
| Pin the pending-only lease branch even though it 404s the same as no-lease? | **Yes — it's a distinct execution path.** A pending-only lease fails the FIRST query (units JOIN on `l.status='active'`), not the second (`status IN ('pending','active')`). Pinning the branch means a future refactor that promotes the first query to also accept 'pending' would be caught by the test (red on intentional behavior change). |
| Use the existing seedLease helper or write raw lease INSERTs? | **Helper.** seedLease already handles default values cleanly and matches the pattern used in tenants-flex.test.ts and tenants-profile-dashboard.test.ts — consistent with the slice 1/2 patterns. |

## Observations (not bugs, not test targets)

These came out of recon. None warrant a fix in this slice;
captured here for future reference.

### A. /lease tenant_name reflects the PRIMARY tenant always

`GET /lease` joins `v_unit_occupancy` which exposes
`primary_first_name/last_name`. A co-tenant calling
/lease sees the lease detail correctly but the
`tenant_name` field is the PRIMARY's name, not their own.
This is fine for display purposes ("Your lease is in
Primary's name") but could be confusing if shown to the
co-tenant as "your name." Frontend treats this carefully
in the LeasePage — not a backend bug.

### B. /lease error copy "No active unit"

The 404 message reads "No active unit" but the branch
triggers when the tenant has no active lease_tenants row.
A landlord debugging a tenant complaint might check unit
status (which IS active) and be misled. Cosmetic copy
issue; not worth a fix without a product call on the
broader error-vocabulary pass.

### C. /lease only returns the *most recent* active lease

`ORDER BY l.created_at DESC LIMIT 1` — if a tenant has
multiple leases on the same unit (e.g., one ended and a
renewal started without cleanup), only the most recent
surfaces. In practice leases on the same unit don't
overlap, but if a data import or manual fix creates an
overlap, the older lease becomes invisible to the tenant.
Worth knowing during data-migration audits.

## Verification

- `npx tsc --noEmit` clean on apps/api (0 errors).
- `npm test` in apps/api: **1149 tests across 67 files,
  0 failures**, 610.97s.
- 10 new test cases (`tenants-lease.test.ts`).
- 0 production bug fixes.
- 0 production regressions.

The 48 tenants.ts tests from slices 1–4 (`tenants-profile-
dashboard.test.ts` 13, `tenants-flex.test.ts` 16,
`tenants-actions.test.ts` 9, `tenants-invite.test.ts` 15)
all continued to pass.

## Items deferred — what S379 could target

### tenants.ts remaining slices (~11 routes left)

S374 + S375 + S376 + S377 + S378 covered 29 of tenants.ts's
40 routes (~73%). Remaining:

- **Admin-facing /:id/profile + /:id/transfer +
  /:id/available-units** (3 routes — landlord/admin views
  of a specific tenant)
- **Profile patch + avatar POST + avatar GET +
  password** (4 routes — tenant self-edit)
- **Work-trade + charge-account** (2 routes — read-only
  status views)

Plus the `/avatar-files/:filename` route (static-ish
multer-served asset, may or may not be worth a test).

Natural next slice options:

- **Tenant self-edit slice (4 routes):** profile patch,
  avatar POST, avatar GET, password. Medium yield —
  avatar upload paths sometimes hide path-traversal or
  permission bugs. Multer is involved which adds setup
  complexity.
- **Admin-facing :id/* slice (3 routes):** /:id/profile +
  /:id/transfer + /:id/available-units. Lower yield;
  permission-gated read paths typically don't surface
  bugs in test sweeps unless the gates themselves are
  off. But /:id/profile is a complex aggregation route
  (~120 lines in the file) and worth pinning.
- **Misc tenant-readonly slice (2 routes):**
  work-trade + charge-account. Smallest possible slice
  — clean closure of the remaining single-read routes.

**Recommend the admin-facing /:id/* slice for S379** —
the /:id/profile aggregation is the largest remaining
route and most likely to surface schema-drift or join
bugs. Tenant self-edit can follow as slice 7; work-trade
+ charge-account as slice 8 to close the tenants.ts arc.

That's three more sessions to finish tenants.ts.

### Per Nic's directive: "we need to finish all the portals"

After tenants.ts (3 more slices), the arc map across
portals is roughly:

- **tenants.ts** (this arc) — 73% covered, ~3 slices to
  close
- **landlords.ts** — partial coverage from earlier
  sessions (slices in landlords-otp / landlords-email-
  pmimpact)
- **pm.ts** — slice coverage on companies + staff +
  fee plans; property invitations / Connect / payouts /
  drilldown still pending (per deferred docket)
- **properties.ts** — units/bulk + photos + listings +
  apply + applications still pending
- **units.ts** — /:id/economics + /:id/eviction-mode
  walkthrough-blocked
- **admin.ts, admin-ops.ts, esign.ts, books.ts, pos.ts,
  maintenance.ts, payments.ts, ...** — unknown coverage
  state; needs an audit-style mapping pass to enumerate
  what's left

A useful next move once tenants.ts closes would be to
**audit the full route-test coverage map** — generate a
quick report per route file (X of Y routes covered) so
slicing decisions across portals are informed instead of
guessed.

### Pending from S376 + S377 (carried)

- **FlexCredit ↔ rent-reporting product naming** (S376)
  — Nic-pending
- **Invite token leakage** (S377-A) — Nic-pending
- **email_verify_token column overload** (S377-B) —
  schema refactor candidate
- **Invite token expiry policy** (S377-C) — Nic-pending

### **NEXT FRESH-CONTEXT SESSION:** Checkr API wire-up

Unchanged from S375/S376/S377. Memory note
`project_checkr_access_unblocked.md` is the locked priority
for a fresh window.

### Architectural / non-test (carried)

- **Unicode-capable font in flexsuitePdf**
- **responsibleParty source-comment drift fix**

### Hardening flagged (carried)

- **logAdminAction targetId-uuid audit**
- **silent-failure pattern audit**
- **schema-drift audit** — 4 instances (S355/S360/S370/S374)
- **arc-completeness verification at close time**

### Vendor-blocked / walkthrough-blocked / dev-team scope

(All unchanged from S377.)

## Items deferred (cross-session docket, post-S378)

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
- schema-drift audit (4 instances — codebase-wide grep priority)
- arc-completeness verification at close time (process hardening)
- tenants.ts remaining: admin /:id/* + profile-patch/avatar/password
  + work-trade + charge-account
- **(S376)** FlexCredit ↔ rent-reporting product naming —
  Nic-pending resolution
- **(S377)** Invite token leakage / column overload / expiry —
  Nic-pending
- **(S378-new)** Route-test coverage audit across all
  portals — generate per-file (X of Y) report once
  tenants.ts is done, to inform cross-portal slicing
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

## What S379 should target

**Recommended path:** continue the tenants.ts arc with the
**admin-facing /:id/* slice** (3 routes: /:id/profile +
/:id/transfer + /:id/available-units). /:id/profile is the
biggest remaining route and the most likely to surface
schema-drift or aggregation bugs. ~8-10 tests.

Then slice 7 = tenant self-edit (4 routes), slice 8 =
work-trade + charge-account (2 routes) to fully close
tenants.ts. Three more sessions.

Per Nic's "finish all the portals" directive: after
tenants.ts closes, recommend a **route-test coverage audit
pass** to enumerate what's left per portal before picking
the next arc. This avoids picking slices blind across
unfamiliar surfaces.

---

End of S378 handoff. tenants.ts arc slice 5 of N covered
(3 lease-view routes). 1149 tests / 67 files / 0 failures.
0 production bugs surfaced.
