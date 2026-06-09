# Session 371 — closed

## Theme

admin.ts arc continues. **Slice 5 of N:** deposit-
portability + connect-readiness + landlord-banking-nudges
(6 admin operational tools with Stripe boundary).

The slice surfaced **0 production bugs**. The Stripe
boundary routes (backfill, refresh) properly forward
fetchAccountStatus errors into a per-row `errors[]` array
without failing the request — pinned with an explicit
mockRejectedValueOnce case.

11 new test cases pin the slice.

Suite at S370 close: **1062 / 59 files**.
Suite at S371 close: **1073 / 60 files** (+11 cases, +1
file).

Zero tsc regressions, zero production regressions.

## Items shipped

### Test coverage — 11 cases / 6 describe blocks

New file: `apps/api/src/routes/admin-deposit-connect.test.ts`

**GET /admin/deposit-portability/pending (1)**
- Returns rows where security_deposits.portability_status
  = 'pending_transfer'; joined to tenant + new-landlord +
  prev-landlord context via the multi-table chain

**POST /admin/deposit-portability/:id/mark-transferred (3)**
- Not found → 404
- Wrong status (e.g. already 'carried_forward') → 409
  with state context in the error message
- Happy: flips to carried_forward + appends admin
  timestamp + user-supplied notes to the existing notes
  field (the route uses LEFT/COALESCE append pattern,
  preserving any prior notes)

**POST /admin/connect-readiness/backfill (3)**
- Empty (no Connect accounts) → 0/0 counts; Stripe NOT
  called; audit log row written with action_type=
  'connect_readiness_backfill'
- Seeded user + pm_company with `stripe_connect_account_
  id` and FALSE flags → fetchAccountStatus called twice;
  flags + stripe_connect_status_synced_at updated on
  both rows; updated counter reflects success
- **Stripe throws for one row → errors[] increments; scan
  continues; request stays 200.** Pins the per-row
  resilience contract (one bad account doesn't fail the
  whole backfill)

**GET /admin/connect-readiness/accounts (1)**
- Returns union of users + pm_companies that have
  stripe_connect_account_id set; both entity_types
  surface in the response

**GET /admin/landlord-banking-nudges (1)**
- Reads from email_send_log filtered to category=
  'landlord_banking_nudge'; unrelated categories
  excluded

**POST /admin/connect-readiness/refresh/:entity/:id (2)**
- Invalid entity ('widget') → 400 "entity must be 'user'
  or 'pm_company'"
- Happy (entity=user): fetchAccountStatus called; user
  row flags updated; admin_action_log row written with
  target_id=userId + target_type='user'

### Test infra additions

- Mock for `services/stripeConnect.fetchAccountStatus`
  with vi.hoisted (similar pattern to S358's Stripe
  disputes mock).
- No cleanup helper changes — security_deposits is
  already wiped, pm_companies CASCADE'd via S352.

## Files touched

```
apps/api/src/routes/
  admin-deposit-connect.test.ts   (NEW — 245 lines, 11 cases)
```

No production code touched. No migrations. No schema
changes. No cleanup helper changes.

## Decisions made during build

| Question | Decision |
|---|---|
| Probe for schema-drift bugs (S355/S360/S370 class) on the deposit-portability JOINs? | **Probed — clean.** The `/pending` route has a 5-level JOIN chain (security_deposits → tenants → users + units → properties → landlords); all column references match the current schema. The route uses defensive LEFT JOINs for the prev-landlord chain (carried_from_deposit_id may be null), so missing context doesn't crash. |
| Probe for the S368 logAdminAction-targetId-uuid bug on connect-readiness backfill/refresh? | **Probed — clean.** `connect_readiness_backfill` (backfill) doesn't pass targetId. `connect_readiness_refresh` passes `req.params.id` which IS a real uuid (users.id or pm_companies.id). Both pass the audit log write. |
| Test backfill's pm_company error path separately from user error path? | **Just user side.** Both paths use the same per-row try/catch pattern; testing one pins the contract. The user-vs-pm distinction is structural (which table to UPDATE) but the error-handling shape is identical. |
| Test single-row refresh for entity=pm_company too? | **Skipped — same shape as user.** The route uses `const table = entity === 'user' ? 'users' : 'pm_companies'` as the only difference. Testing user path pins the contract; pm_company is a single-line variant. |
| Test the `notes` append-truncation logic (LEFT(... , 2000))? | **Skipped — mechanical SQL.** The append uses LEFT(notes, 2000) to clamp accumulated notes; testing the truncation would require seeding a deposit with 1990-char notes then submitting 100 more chars to verify clamp behavior. Lower yield than the timestamp-prefix + user-notes-append pin. |
| Audit-log row test on the bulk backfill — verify metadata shape? | **Just action_type pinned.** The metadata's per-key counts (users_scanned, pm_companies_updated, etc.) are derived from the same `result` object the response returns; testing them on the audit log would duplicate the response-shape assertion. |
| Test fetchAccountStatus retry / rate-limit handling? | **Out of slice.** The route runs in series; no retry logic at this layer. Stripe's rate-limit handling is a service-level concern. |

## Verification

- `npx tsc --noEmit` clean on apps/api (0 errors).
- `npm test` in apps/api: **1073 tests across 60 files, 0
  failures**, ~578s.
- 11 new test cases (`admin-deposit-connect.test.ts`).
- 0 production bug fixes.
- 0 production regressions.

No frontend touched, no shared-package touched.

## Items deferred — what S372 could target

### admin.ts remaining slices (~5 routes left to close
the arc)

S362 + S368 + S369 + S370 + S371 covered ~36 of admin.ts's
~40 routes (~90%). Remaining:

- **OTP advance retry + FlexCharge statement retry** (2
  routes — Stripe boundary operational helpers)
- **Tenant onboarding detail + FlexSuite acceptances**
  (2 routes — parallel to S369's landlord onboarding
  detail)

Then admin.ts arc closes.

### **NEXT FRESH-CONTEXT SESSION:** Checkr API wire-up

Memory note `project_checkr_access_unblocked.md` is the
priority. Nic obtained Checkr Partner credentials
2026-05-26. The next fresh-context session starts with
wiring `background.ts` to live Checkr (real product
integration). Per `feedback_checkr_otp_unrelated.md`,
frame Checkr as background-check product going live, NOT
as unblocking OTP.

### Other admin-surface route slices (after admin.ts arc
completes)

```
tenants.ts               1326  NO TESTS
books.ts                 1330  NO TESTS
background.ts            1065  NO TESTS  ← Checkr-blocked, see memory
credit.ts                 839  NO TESTS
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

### Architectural / non-test (carried)

- **Unicode-capable font in flexsuitePdf** — open since
  S333.
- **responsibleParty source-comment drift fix** —
  one-liner.

### Hardening flagged

- **action.url scheme validation in adminNotifications**
- **logAdminAction targetId-uuid audit** (codebase-wide
  hygiene pass) — surfaced S368
- **silent-failure pattern audit** (try/catch swallow
  class) — leaseFeesSync (S360) + logAdminAction (S368)
- **schema-drift audit** — S355/S360/S370 (3 instances of
  routes referencing columns that don't exist)

### Vendor-blocked / walkthrough-blocked / dev-team scope

(All unchanged from S370.)

## Items deferred (cross-session docket, post-S371)

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
- admin.ts remaining: OTP/FlexCharge retry + tenant onboarding detail + FlexSuite acceptances
- logAdminAction targetId-uuid audit (codebase-wide hygiene pass)
- silent-failure pattern audit (try/catch swallow class)
- schema-drift audit on admin.ts SQL columns
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

## What S372 should target

**S372 should close the admin.ts arc** with the last 4
routes:
- OTP advance retry + FlexCharge statement retry (Stripe
  ops helpers)
- Tenant onboarding detail + FlexSuite acceptances
  (parallel to landlord onboarding detail in S369)

Likely ~8-10 tests. After S372, admin.ts arc is complete
and the test sweep continues onto the next file in the
unwalked queue (tenants.ts / books.ts / credit.ts / etc.).

If clearing for fresh context: per memory note, start
S372 with the **Checkr API integration in background.ts**
before returning to the test sweep.

---

End of S371 handoff. Closed clean. 1073 tests / 60 files
/ 0 failures. admin.ts slice 5 of N covered (deposit-
portability + connect-readiness + landlord-banking-
nudges). 0 production bugs. admin.ts arc ~90% complete
— one slice left to close it.
