# Session 352 — closed

## Theme

Picked `pm.ts` (1078 lines, NO TESTS, multi-slice candidate)
per the S351 recommendation. Sliced the first cut: **companies
CRUD + staff CRUD + fee plans + invitations** (8 of pm.ts's
24 routes). Connect onboarding, payouts, drilldown, and
property invitations carved out for future sessions.

The slice surfaced **0 production bugs**. Like S349
(scopes.ts) and S350 (bookings.ts), pm.ts is well-defended on
the routes covered: assertPmStaffRole gates owner/manager/
staff role tiers consistently, last-owner safety check
prevents demotion-to-orphan, bankAccountId is owner-only,
fee-plan per-feeType required-field validation enforces
shape beyond the loose schema CHECK, invitation acceptance
includes a FOR UPDATE lock + email-match guard against token
theft + persisted expired-status flip on stale tokens.

17 new test cases pin the slice — bigger than planned (14)
because the role-tier matrix had more interesting cases than
recon suggested. Coverage includes: company create (auto-
owner txn), list (caller-scoped), get (non-staff 403),
patch (manager vs owner field permissions), staff add (happy
/ dup / non-owner), staff demotion (last-owner protection),
fee-plan validation (missing required field for fee_type),
invitation send (happy / dup-active / dup-pending), and
invitation accept (happy / email-mismatch / expired-with-
persisted-status-flip).

Suite at S351 close: **834 / 41 files**.
Suite at S352 close: **851 / 42 files** (+17 cases, +1 file).

Zero tsc regressions, zero production regressions.

## Items shipped

### Test coverage — 17 cases / 8 describe blocks

New file: `apps/api/src/routes/pm.test.ts`

**POST /companies (1)**
- Happy path: caller auto-becomes owner pm_staff in same
  transaction (verifies the BEGIN/COMMIT wrapping the
  company + first staff insert)

**GET /companies (1)**
- Lists only companies caller is staff of (two companies
  under two different owners; A's token returns only A's
  with my_role='owner')

**GET /companies/:id (1)**
- Non-staff caller (no pm_staff row) → 403 "Not a staff
  member"

**PATCH /companies/:id (1)**
- Manager can edit company details (name); manager
  attempting to set bankAccountId → 403 (owner-only gate
  via the second assertPmStaffRole call)

**POST /companies/:id/staff (3)**
- Owner adds existing user happy path; invited_by_user_id
  stamped
- Duplicate user already member → 409 via the
  pm_staff_unique_membership 23505 translator
- Non-owner caller (manager) trying to add staff → 403
  "Requires role: owner"

**PATCH /companies/:id/staff/:staffId (2)**
- Last-owner demotion → 409; role unchanged
- Owner can demote second owner when 2+ owners exist
  (validates the count check at line 272-279)

**POST /companies/:id/fee-plans (2)**
- percent_of_rent without percent field → 400 with
  feeType-specific message
- percent_with_floor happy: both fields set, numeric
  roundtrip clean

**POST /companies/:id/invitations (3)**
- Owner sends invite: row + email fired with 32-byte hex
  token
- Invite email matches existing active staff → 409; email
  not fired
- Duplicate pending invite (same company + email) → 409
  via the pm_invitations_unique_pending 23505 translator

**POST /invitations/accept (3)**
- Happy path: caller email matches → pm_staff row created,
  invitation flips to accepted with accepted_user_id
  stamped
- Caller email does NOT match invite email → 403 (token-
  theft guard at line 567-569); invite stays pending
- Expired invitation → 409 AND status flip to 'expired'
  persists (the route COMMITs the status flip before
  throwing, so the persisted change survives even though
  the outer route appears to "fail")

### Test infra additions

`dbHelpers.cleanupAllSchema` extended with
`DELETE FROM pm_companies` near the end. CASCADE on
pm_staff / pm_invitations / pm_fee_plans /
pm_property_invitations handles transitive cleanup;
pm_monthly_fee_accruals (RESTRICT) is already wiped
earlier. landlords.default_pm_company_id and
properties.pm_company_id are SET NULL, so they don't
block the pm_companies delete.

### Surfaces NOT covered (out of slice)

- `/companies/:id/connect/onboarding-link` — Stripe
  ensureConnectAccount + createOnboardingSession; needs
  Stripe mock setup
- `/companies/:id/connect/account-status` — Stripe
  fetchAccountStatus; same mock setup
- `/companies/:id/payouts` — Stripe Payouts list mirror
- `/companies/:id/properties/:propertyId/drilldown` —
  owner-visibility view (115 lines)
- `/companies/:id/property-invitations` (5 routes) —
  PM ↔ landlord property-assignment handshake; separate
  bidirectional flow
- `/invitations/property/:token` public accept-screen
  endpoint for the property handshake
- DELETE /companies/:id/invitations/:invId revoke — same
  shape as scopes.ts revoke (covered S349)

### Surfaced design notes (not bugs)

1. **PATCH /companies/:id allows manager to change
   `status`** (PM_COMPANY_STATUSES = active / inactive /
   suspended). Only bankAccountId is gated owner-only.
   Whether status changes should be owner-only is a
   product question — assertPmStaffRole at the top of
   the route enables `['owner', 'manager']` for the
   whole field set, with the bankAccountId carve-out.
   Not a bug; flag for Nic if status-change permission
   tier matters.

2. **assertPmStaffRole does not check
   `pm_companies.status`**. A suspended company's staff
   still have full access to all endpoints. If the
   suspended status is supposed to lock operations,
   that's a missing check. CLAUDE.md doesn't specify the
   semantic of pm_companies.status; could be
   informational-only, could be operational. Surface to
   Nic.

## Files touched

```
apps/api/src/routes/
  pm.test.ts                (NEW — 360 lines, 17 cases)

apps/api/src/test/
  dbHelpers.ts              (+7 lines: pm_companies cleanup w/ CASCADE comment)
```

No production code touched. No migrations. No schema changes.

## Decisions made during build

| Question | Decision |
|---|---|
| Slice pm.ts into companies+staff+feeplans+invitations OR include Connect onboarding too? | **Slice without Connect.** Connect onboarding routes need Stripe service mocks (ensureConnectAccount, createOnboardingSession, fetchAccountStatus) — adds significant mock setup for low marginal yield on this session. Separate slice when needed. |
| Skip property-invitations (5 routes, ~165 LoC) or include? | **Skip.** Property invitations are a separate bidirectional handshake flow (Landlord ↔ PM Company) with its own services/pm.ts helpers + token semantics. Better as its own slice with focused recon. |
| Probe for bugs given the 17/17 first-run pass (per S347/S348 pattern)? | **Light probe done, no bug surfaced.** Recon flagged 2 design questions (status-change perm tier, pm_companies.status check) but neither is a clear bug — both are product semantics that CLAUDE.md doesn't pin. Flagged in handoff for Nic. The slice itself is genuinely well-defended; the S107-S112 build was thorough. |
| Mock emailPmInvitation only, or also emailPmPropertyInvitation? | **Both.** Even though this slice doesn't exercise the property-invitation flow, the import at the top of pm.ts means Vitest's resolver will look for both. Mocking both prevents accidental real-Resend hits if a future probe test hits a property-invitation route. |
| Last-owner demote test — also test removal (status='removed') variant? | **Skipped.** The guard at line 266 covers both `role='staff'|'manager'` AND `status='removed'|'inactive'` — same code path. Adding a removal-variant test would be ceremony for low yield. Demotion test pins the count check; removal would hit the same branch. |
| Token-theft guard test (email mismatch on accept) — set attacker.email manually or use seedUser default randomization? | **Default randomization.** seedUser generates a random email per call, so two seedUser calls produce different emails by construction. The test reads cleaner without manual email overrides. |
| Expired-invite test — assert the rollback semantic, or just the route response? | **Both.** The route's expired branch COMMITs the status flip *before* throwing the 409. The outer catch then attempts a ROLLBACK that does nothing (transaction is already committed). This is subtle behavior worth pinning — if anyone moves the status flip to after the throw, the test fails. |

## Verification

- `npx tsc --noEmit` clean on apps/api (0 errors).
- `npm test` in apps/api: **851 tests across 42 files, 0
  failures**, ~386s.
- 17 new test cases (`pm.test.ts`).
- 0 production bug fixes.
- 0 production regressions.

No frontend touched, no shared-package touched.

## Items deferred — what S353 could target

### pm.ts remaining surfaces (multi-slice continuation)

After S352, pm.ts still has 16 untested routes:
- **Property invitations** (5 routes, ~165 LoC) — owner↔
  landlord handshake flow. Self-contained surface, good
  candidate for next slice.
- **Connect routes** (2: onboarding-link + account-status)
  — Stripe boundary, needs mocks similar to terminal routes
  from S345.
- **Payouts / drilldown** (2 routes) — owner-visibility
  views, straightforward but specialized seeding.
- **Invitations revoke** (1 route, already shape-tested
  via scopes.ts S349 equivalent) — low marginal yield.

### Admin-surface route slices still uncovered

```
landlords.ts             3817  NO TESTS  ← biggest unwalked file
admin.ts                 1514  NO TESTS
tenants.ts               1326  NO TESTS
books.ts                 1330  NO TESTS
background.ts            1065  NO TESTS
properties.ts            1025  NO TESTS
credit.ts                 839  NO TESTS
units.ts                  513  NO TESTS
reports.ts                489  NO TESTS
payments.ts               429  NO TESTS
utility.ts                387  NO TESTS
workTrade.ts              331  NO TESTS
stripe.ts                 279  NO TESTS
subleaseInvitations.ts    269  NO TESTS
bulletin.ts               261  NO TESTS
posCustomerOnboarding.ts  253  NO TESTS
fitness.ts                215  NO TESTS
withdrawals.ts            181  NO TESTS
finances.ts               138  NO TESTS
bankAccounts.ts           129  NO TESTS
notifications.ts           84  NO TESTS
terminal.ts                66  NO TESTS
disbursements.ts           45  NO TESTS
documents.ts               32  NO TESTS
announcements.ts           20  NO TESTS
```

**Recommended next picks for S353:**

1. **`units.ts`** (513, NO TESTS) — companion to
   bookings.ts (S350). Per-unit booking CRUD lives here.
   Closes the booking subsystem coverage.
2. **`pm.ts` property invitations slice** — continue the
   pm.ts multi-session arc. Self-contained handshake flow.
3. **`landlords.ts`** (3817) — first slice of the
   multi-session arc. Pick a well-bounded surface
   (signup / profile / Connect onboarding).
4. **`tenants.ts`** (1326) — largest non-admin file.
   Tenant profile / portal data. Multi-slice candidate.

**Skip-for-now:**
- `documents.ts` / `disbursements.ts` / `announcements.ts`
  — too small for dedicated slices.
- `payments.ts` (429) / `withdrawals.ts` (181) — money
  paths, but stripeConnectTransfers + webhooks already
  pin critical flows.

### Architectural / non-test (carried)

- **Unicode-capable font in flexsuitePdf** — open since
  S333.
- **responsibleParty source-comment drift fix** — one-liner.

### Design questions surfaced this session (Nic-pending)

- **pm_companies.status semantic** — should suspended
  companies' staff lose access to /companies/:id*
  endpoints?
- **status change permission tier** — should
  PATCH /companies/:id status be owner-only (vs current
  manager-allowed)?

### Hardening flagged (no live risk, carried)

- **action.url scheme validation in adminNotifications** —
  flagged S344.

### Vendor-blocked / walkthrough-blocked / dev-team scope

(All unchanged from S351.)

## Items deferred (cross-session docket, post-S352)

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
- pm_companies.status semantic — Nic-pending
- pm.ts status-change permission tier — Nic-pending

## Nic-pending (unchanged)

- Stripe live keys + production webhook URL registered
- Resend domain verification
- Plaid production keys
- Stripe Terminal hardware
- Checkr Partner credentials
- Consumer-side retention framing decision (S300)
- FlexCredit Lender partner selection
- SLA § 9.1.4(iii) deposit-return offset framing call

## What S353 should target

Bug-yield over the last 6 sessions:
- S347 (POS inventory): 2 / 10
- S348 (maintenance-portal): 5 / 15
- S349 (scopes): 1 / 18
- S350 (bookings): 0 / 8
- S351 (entryRequests): 1 / 13
- S352 (pm companies+staff+fees+invites): 0 / 17

Running 6-session average: ~1.5 bugs/session, ~6.5% bug-
per-test rate. The S349/S350/S352 zeros came on
well-defended surfaces — scopes (S236 hardening), bookings
(small + parameterized), pm (S107-S112 thorough build).
The S347/S348/S351 hits came on older or larger un-walked
surfaces with looser defensive shape.

**Top recommendation: `units.ts`** (513 lines). Per-unit
booking CRUD lives here — companions S350's bookings list.
Closes the booking subsystem to ~100% coverage. Bug-yield
moderate (mid-size file, mixed defensive shape likely
given the Master Schedule subsystem evolved through
multiple sessions).

Backup: **`pm.ts` property invitations slice** — continue
the pm.ts arc. Self-contained handshake flow, ~165 LoC,
similar shape to the S349 scopes/invitations coverage.

Bigger-target option: **`landlords.ts`** (3817) — biggest
unwalked file in the codebase. Multi-session arc. Pick a
well-bounded slice (signup / Connect onboarding / etc.).
Bug-yield expected high given size.

---

End of S352 handoff. Closed clean. 851 tests / 42 files /
0 failures. pm.ts companies+staff+feeplans+invitations
slice covered. 0 production bugs surfaced — pm.ts is
well-defended on the routes covered. Two product-design
questions surfaced for Nic: pm_companies.status semantic
+ status-change permission tier.
