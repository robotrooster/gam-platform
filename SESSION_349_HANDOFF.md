# Session 349 — closed

## Theme

Continuing the S347/S348 admin-surface route-test sweep per the
"unwalked admin surfaces still surface real bugs" pattern.
Picked `scopes.ts` (735 lines, NO TESTS) — team permissions
code, security-critical surface. The S236 self-edit guards
were the highest-value cases to pin.

The slice surfaced **1 real bug** — meaningfully tighter than
S347/S348 because scopes.ts is well-defended (S236 hardening
landed late-S190s, FOR UPDATE locks on accept, dup checks on
invite, landlord_id scoping throughout). The bug that did
surface is a **race in the onsite-manager platform-wide
uniqueness check**: invite-time guard prevents most cases, but
two landlords inviting the same email concurrently both create
pending invites; the second accept then crashes with a raw
postgres 23505 error (500) instead of a clean 409. Schema
UNIQUE(user_id) on onsite_manager_scopes prevents the actual
data corruption (the second scope row is rejected at the DB
layer) — so this is a **UX-class bug, not a security bug**.
Data was never at risk; the API just returned an ugly 500 in
a real-world race.

18 new test cases — the largest single-file slice this sweep
so far. The S236 self-edit guards (3 cases) explicitly pin
the three privilege-escalation vectors a PM-with-team-perms
could exploit: own permissions, own scope row, own direct-
deposit toggle. If anyone reverts those guards in the future,
tests fail.

Suite at S348 close: **795 / 38 files**.
Suite at S349 close: **813 / 39 files** (+18 cases, +1 file).

Zero tsc regressions, zero production regressions.

## Items shipped

### Bug fix (1)

**F1 — Onsite-manager accept-path race produces 500 instead of 409**
- `scopes.ts:727-741` — added a 23505 + constraint-name catch
  in the accept transaction's error handler. The schema's
  `onsite_manager_scopes_user_id_key` UNIQUE constraint already
  prevented the data corruption; pre-fix the race produced a
  raw postgres error message in a 500 response. Now produces
  a clean 409 matching the invite-time guard's copy.
- The race: landlord A and landlord B both invite the same
  email as onsite_manager. Both invites land in `pending`
  status (the invite-time guard only catches existing scope
  rows, not other pending invites). Whoever accepts first
  succeeds; the second accept hits the schema UNIQUE
  constraint.
- Test `S349 F1: onsite_manager accept-path enforces
  platform-wide one-landlord rule` pins both halves: (a)
  second accept → 409 (not 500), and (b) only one scope row
  exists in the table after the race resolves.

### Test coverage — 18 cases / 6 describe blocks

New file: `apps/api/src/routes/scopes.test.ts`

**S236 self-edit guards on property_manager routes (4)**
- PATCH `/property_manager/:userId/permissions` on SELF →
  403; underlying perms row untouched
- PATCH `/property_manager/:userId` (scope row) on SELF →
  403; maint_approval_ceiling_cents stays null
- PATCH `/property_manager/:userId/direct-deposit` on SELF →
  403; notification not fired; direct_deposit_enabled stays
  false
- Landlord can PATCH any manager's direct-deposit; on
  false→true fires `manager_direct_deposit_enabled`
  notification

**Cross-landlord guards on scope-row CRUD (2)**
- DELETE `/:roleType/:userId` cross-landlord → 404, victim row
  still present
- PATCH `/:roleType/:userId/permissions` cross-landlord → 404

**POST /:roleType/invite (4)**
- Happy path: invitation row + platform_events row created,
  emailInvitation mock called once, token is 32 bytes hex
- Invalid roleType (`grand_wizard`) → 400
- Duplicate pending invite (same landlord+role+email) → 409
- onsite_manager invite when target user is already onsite for
  another landlord → 409 (invite-time guard)

**PATCH /:roleType/:userId/permissions — bookkeeper rejection (1)**
- bookkeeper → 400 with "accessLevel" hint (bookkeeper uses
  accessLevel, not boolean perm toggles)

**POST /invitations/:token/accept (4)**
- Happy path: new user + scope row + invitation status flips
  to 'accepted'
- Expired invitation → 400; no user created
- F1: onsite_manager accept-path race → 409 with clean error
  message (pins the bug fix above)
- Cross-role mismatch (existing landlord user accepting
  maintenance invite) → 409; no scope row created

**POST /invitations/:id/revoke + /resend (3)**
- Revoke pending → status=revoked + platform_events
  'invitation.revoked' row
- Cannot resend a non-pending (revoked) invitation → 400
- Cross-landlord revoke → 404; victim invitation still
  pending

### Surfaces NOT covered

Documented in test file header:
- `connect-status` route (Stripe boundary; mock would add
  little coverage beyond auth check)
- GET `/:roleType` and GET `/team` listing endpoints
  (mechanical SELECTs with landlord-scoped WHERE; low yield)
- Resend-from-pending happy path (write-time platform_events
  side effect; structural duplicate of revoke happy path)

### Test infra additions

`dbHelpers.cleanupAllSchema` extended with 6 new tables:
- `platform_events` (FKs invitations via subject_id)
- `property_manager_scopes`, `onsite_manager_scopes`,
  `maintenance_worker_scopes`, `bookkeeper_scopes` (all FK
  users + landlords RESTRICT)
- `invitations` (FKs landlords + users)

Cleared in dependency order — events first (FKs invitations),
then scope tables (FK users + landlords), then invitations
(FKs landlords + users), then properties / landlords / tenants
/ users (existing order).

## Files touched

```
apps/api/src/routes/
  scopes.ts                 (+13 -2 lines: F1 fix)
  scopes.test.ts            (NEW — 425 lines, 18 cases)

apps/api/src/test/
  dbHelpers.ts              (+13 lines: scope tables + events + invitations cleanup)
```

No migrations. No schema changes. No frontend changes. No
shared-package changes.

## Decisions made during build

| Question | Decision |
|---|---|
| First run came back 17/17 passing — stop or probe deeper? | **Probe.** The bug-pipeline pattern from S347/S348 suggested at least one bug in any 700-line admin file with NO TESTS. Recon flagged the onsite-manager invite-time check as racy on paper; wrote the probe test that exposed the 500-vs-409 bug. The probe paid off; without it I'd have closed 17 tests with the 500 bug still latent. |
| F1 fix posture — fix the race at invite time, fix at accept time, or just translate the 23505? | **Translate the 23505.** The data integrity is already enforced by the schema UNIQUE constraint — the bug is purely about the API returning a clean 409 instead of a 500-with-postgres-leak. Fixing the race "properly" (e.g., re-checking platform-wide uniqueness at accept time with row locks) would be over-engineering: the race window is tiny, the data is safe, and the existing FOR UPDATE on the invitation row plus schema constraint together cover the actual integrity requirement. The translator is 4 lines and matches the same pattern used at the invite-time guard. |
| Test the F1 race naturally via two `/invite` calls, or directly INSERT pending invites? | **Direct INSERT to simulate race.** The invite-time dup check is landlord-scoped (`WHERE landlord_id=$1 AND role=$2 AND email=$3 AND status='pending'`), so two `/invite` calls from different landlords both succeed and create pending invites — no race needed. But to make the test deterministic and self-documenting about *which* race we're pinning, I direct-inserted both invites with known tokens. The test header explains the race. |
| Self-edit-guard tests — use real PM JWT or stub the role check? | **Real PM JWT + scope row.** The S236 guards only fire when `req.user!.role === 'property_manager'`. Using a stubbed/landlord token would bypass the guard (OWNER_ROLES auto-pass requirePerm AND skip the self-edit check), invalidating the test. Wrote `seedManagerWithScope` helper that creates a real PM user with team.manage_permissions in their perms blob — that's exactly the privilege-escalation profile S236 was hardening against. |
| Mock services/email + services/notifications, or let them no-op? | **Mock both.** emailInvitation hits Resend in prod; createNotification writes to DB *and* fires email. Letting them run would pollute the test DB (notification_preferences not relevant here) and risk a Resend round-trip in CI/dev. Mocks are minimal — both vi.hoisted with no-op async functions. |
| Bookkeeper PATCH /permissions reject test — verify the actual scope row doesn't exist too, or just the 400? | **Just the 400.** The guard fires before any DB read (no scope-row lookup). Asserting "no DB change" would require seeding a bookkeeper user first, which doesn't add coverage on the actual guarded path. |
| Mock signature `async () => 'msg'` vs `async (..._args: any[]) => 'msg'`? | **Variadic.** TS strict-mode flagged accessing `mock.calls[0]![0]` on an empty-tuple Parameters type (the no-arg version produces `[]`). Variadic any[] is the minimal change that keeps the test-assertion code clean. |

## Verification

- `npx tsc --noEmit` clean on apps/api (0 errors).
- `npm test` in apps/api: **813 tests across 39 files, 0
  failures**, ~415s.
- 18 new test cases (`scopes.test.ts`).
- 1 production bug fix (`scopes.ts:727-741`).
- 0 production regressions.

No frontend touched, no shared-package touched, so per-portal
tsc sweeps not needed this session.

## Items deferred — what S350 could target

### Admin-surface route slices still uncovered

After S349, the surface map (sorted by bug-yield expectations):

```
landlords.ts             3817  NO TESTS  ← biggest unwalked file
admin.ts                 1514  NO TESTS
tenants.ts               1326  NO TESTS  ← largest non-admin
books.ts                 1330  NO TESTS  ← cleared S145
pm.ts                    1078  NO TESTS  ← third-party PM
background.ts            1065  NO TESTS
properties.ts            1025  NO TESTS
credit.ts                 839  NO TESTS
auth.ts                   566  NO TESTS  (slices already covered)
units.ts                  513  NO TESTS
reports.ts                489  NO TESTS
entryRequests.ts          439  NO TESTS  ← credit-ledger
payments.ts               429  NO TESTS  ← money path
utility.ts                387  NO TESTS
workTrade.ts              331  NO TESTS
stripe.ts                 279  NO TESTS
subleaseInvitations.ts    269  NO TESTS
bulletin.ts               261  NO TESTS
posCustomerOnboarding.ts  253  NO TESTS
fitness.ts                215  NO TESTS
withdrawals.ts            181  NO TESTS  ← money path
finances.ts               138  NO TESTS
bankAccounts.ts           129  NO TESTS
bookings.ts               104  NO TESTS  ← recently-unblocked S143
notifications.ts           84  NO TESTS
terminal.ts                66  NO TESTS
disbursements.ts           45  NO TESTS
documents.ts               32  NO TESTS
announcements.ts           20  NO TESTS  (likely stub)
```

**Recommended next picks for S350:**

1. **`bookings.ts`** (104 lines, NO TESTS) — fast win, books
   the Master Schedule subsystem (S143 unblock) into the test
   suite. Probably ~5-7 tests. Closes a small gap completely.
2. **`entryRequests.ts`** (439, NO TESTS) — credit-ledger
   workflow per CLAUDE.md; recent build means recent
   refactor risk. Similar bug-yield profile to S348's
   maintenance-portal. ~10-12 tests likely.
3. **`landlords.ts`** (3817, NO TESTS) — biggest file in the
   codebase. Would need a multi-session slice (signup /
   profile / Connect / properties-management / etc.). Pick
   one well-bounded surface for any single session.
4. **`pm.ts`** (1078, NO TESTS) — third-party PM company
   subsystem. CLAUDE.md flagged it as feature-complete (S157)
   but it's never been tested. Bug-yield potentially high.
5. **`books.ts`** (1330, NO TESTS) — GAM Books bookkeeping;
   cleared from quarantine S145 but never tested. Money-
   adjacent surface.

**Skip-for-now:**
- `documents.ts` / `disbursements.ts` / `announcements.ts` —
  too small to be worth a dedicated slice.
- `payments.ts` (429) / `withdrawals.ts` (181) — money paths,
  but stripeConnectTransfers + webhooks coverage already
  pins the critical money flows.

### Architectural / non-test (carried)

- **Unicode-capable font in flexsuitePdf** — open since S333.
- **responsibleParty source-comment drift fix** — one-liner.

### Hardening flagged (no live risk, carried)

- **action.url scheme validation in adminNotifications** —
  flagged S344.

### Vendor-blocked

- Stripe live keys, Resend domain auth, Plaid production
  keys, Stripe Terminal hardware, Checkr Partner credentials.

### Walkthrough-blocked

- 2FA fan-out (admin-ops / landlord / pm-company / tenant)
- Visual review of reconstructed PmInvitationsPage
- SchedulePage booking-vs-lease shape audit
- Inventory Log page (S347)
- PO management receive flow (S347)
- Scheduled Maintenance worker UI (S348)

### Dev-team scope

- Deploy host pick + Dockerfile / render.yaml
- Production cron runner
- DB backups + PITR

## Items deferred (cross-session docket, post-S349)

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

## Nic-pending (unchanged)

- Stripe live keys + production webhook URL registered
- Resend domain verification
- Plaid production keys
- Stripe Terminal hardware
- Checkr Partner credentials
- Consumer-side retention framing decision (S300)
- FlexCredit Lender partner selection
- SLA § 9.1.4(iii) deposit-return offset framing call

## What S350 should target

Bug-yield this session: **1 bug / 18 tests** (vs. S348's
5 bugs / 15 tests and S347's 2 bugs / 10 tests). Lower yield
because scopes.ts had been actively hardened (S236) and is
the kind of file where deliberate security work shows up in
the code's defensive posture. Even so, the F1 race wasn't
caught by S236 — it required a slice-test probe to find.

**Recommendation: `bookings.ts`** (104 lines) — close one
surface completely in a short session, get the Master
Schedule subsystem into the test suite. The yield-per-test
will likely be lower than maintenance-portal (S148 unblock
was a positive structural change, not a bug-fix sweep), but
the completeness is worth banking.

Backup if Nic wants higher-yield work: **`entryRequests.ts`**
— credit-ledger workflow, larger surface (~10-12 tests
likely), similar profile to S348's bug-yield. The credit-
ledger spec is well-documented in CLAUDE.md but the routes
have never been walked.

Bigger-target option for a multi-session arc:
**`landlords.ts`** (3817 lines, NO TESTS). Slice it by
surface (auth / profile / properties / Connect / etc.) —
each could be its own session. Almost certainly hides
multiple bugs given the size.

---

End of S349 handoff. Closed clean. 813 tests / 39 files / 0
failures. 1 bug caught + fixed (onsite-manager accept-race
500→409 translation). scopes.ts slice covered — including
explicit pinning of the S236 self-edit guards which had no
prior test coverage. Bug-yield-per-test lower this session;
scopes.ts had been actively hardened.
