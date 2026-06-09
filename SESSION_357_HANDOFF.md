# Session 357 — closed

## Theme

Continued the landlords.ts arc (S356 was slice 1 of N).
**Slice 2:** the /me/todos dashboard rollup route — 200+
lines, 5 queries, S183 PM-delegation filtering. This was
the F1-class probe target per the S356 handoff.

The slice surfaced **0 production bugs**. The S183
hardening (filter day-to-day items by self-managed
properties only; always show owner-financial items like
maintenance awaiting_approval) held up under the full
probe matrix: PM-delegated lease todos filtered out,
maintenance awaiting_approval still shows even on
PM-delegated property, expiring-soon window math correct
on both sides of the boundary, failed-payment 30-day
window honored.

10 new test cases pin the route. Suite at 910 / 46
files / 0 failures.

Suite at S356 close: **900 / 45 files**.
Suite at S357 close: **910 / 46 files** (+10 cases, +1
file).

Zero tsc regressions, zero production regressions.

## Items shipped

### Test coverage — 10 cases / 1 describe block

New file: `apps/api/src/routes/landlords-todos.test.ts`

**Empty + bank readiness (2)**
- Empty fixture (no bank, no leases, no payments) →
  only `landlord-bank` todo appears; counts.total = 1
- Active bank account seeded → no `landlord-bank` todo

**Lease lifecycle (3)**
- needs_review=true → `leases[]` has needs_review item
  with correct shape (title "Lease needs review", href
  with lease id)
- end_date within expiration_notice_days window →
  `expiring_soon` todo (subtitle includes "days
  remaining")
- end_date OUTSIDE window (200 days out, 60-day notice)
  → no lease todo

**S183 PM-delegation filter (2)**
- Lease todo: PM-delegated property (pm_company_id set)
  → lease todos filtered out from owner's view
- Maintenance awaiting_approval: **always shows**, even
  on PM-delegated property — pre-S183 invariant
  preserved (owner-financial concern regardless of
  day-to-day delegation)

**Tenant ACH + payment failure (3)**
- Tenant with ach_verified=false on active unit linked
  via lease + primary lease_tenant → `tenant_ach` todo
  appears via v_unit_occupancy join
- Failed rent pull within last 30 days →
  `recent_failure` todo
- Failed rent pull older than 30 days → no todo
  (window boundary respected)

### Surfaces NOT covered (out of slice — for future
sessions)

(landlords.ts arc remaining — same list as S356, minus
/me/todos)

- POS customers (4 routes) + FlexCharge (4 routes)
- Tenant onboarding (4 routes)
- CSV onboarding (10 routes — properties / tenants /
  payment-history)
- /me/email-failures + /me/pm-impact
- Payouts / disputes / payments-history (4 routes)
- OTP (5 routes)
- PM-property-invitations + default-pm-company (7
  routes)

## Files touched

```
apps/api/src/routes/
  landlords-todos.test.ts   (NEW — 240 lines, 10 cases)
```

No production code touched. No migrations. No schema
changes. No cleanup helper changes.

## Decisions made during build

| Question | Decision |
|---|---|
| Bundle /me/todos into landlords.test.ts (S356's file) or split into landlords-todos.test.ts? | **Split.** /me/todos is a self-contained surface with its own seeding profile (leases + lease_tenants + payments + maintenance). A separate file makes the slice boundaries obvious and keeps each file under ~300 lines for readability. |
| Probe for F1-class drift on /me/todos given S355's bug yield on dashboard-like rollups? | **Yes — primary probe target this session.** Wrote tests against the most-suspect surfaces (S183 PM-delegation filter, expiration-window math, 30-day failed-payment window). All passed first run. The route is genuinely well-defended; S183 explicitly hardened it. |
| Test the maintenance-awaiting-approval branch as a separate case from the always-shown invariant? | **Combined into the PM-delegation test.** The "always shows even on delegated property" is the load-bearing claim from the S183 comment — and the most likely place for someone to mistakenly add a delegation filter in the future. One test pins both the happy path AND the invariant. |
| Test the lease window boundary at exactly the edge (end_date = today + expiration_notice_days)? | **Skipped — used 30/60 (inside) and 200/60 (outside) as clear cases.** Edge boundary tests would pin off-by-one behavior, but the route's SQL is `<=` on both sides which means today+60 (with notice 60) is included. Adding a precise boundary test would be ceremony; the in/out tests catch any wider drift. |
| Verify the SQL date-interval math against timezone edge cases (UTC vs Phoenix)? | **No.** The route uses `CURRENT_DATE` + INTERVAL — these are date-not-timestamp operations, so timezone doesn't apply. The EXTRACT(DAY FROM end_date::timestamp - NOW()) computes integer days, also tz-stable for the days-remaining count. |
| Seed maintenance_requests via the helper or direct INSERT? | **Direct INSERT.** seedMaintenanceRequest doesn't exist in dbHelpers (and would only be used by this one test). Inline INSERT with 6 fields is cleaner than introducing a one-use helper. |

## Verification

- `npx tsc --noEmit` clean on apps/api (0 errors).
- `npm test` in apps/api: **910 tests across 46 files, 0
  failures**, ~467s.
- 10 new test cases (`landlords-todos.test.ts`).
- 0 production bug fixes.
- 0 production regressions.

No frontend touched, no shared-package touched.

## Items deferred — what S358 could target

### **NEXT FRESH-CONTEXT SESSION:** Checkr API wire-up

Memory note `project_checkr_access_unblocked.md` is the
priority. Nic obtained Checkr Partner credentials
2026-05-26. The next fresh-context session starts with
wiring `background.ts` to live Checkr (not a test slice —
real product integration). After that, resume the
test-sweep arc.

### landlords.ts remaining slices

S356 + S357 together covered 9 routes (~17% of
landlords.ts's 3817 lines). Remaining surfaces:

- **POS customers + FlexCharge** (8 routes, ~150 LoC)
- **Tenant onboarding** (4 routes, ~600 LoC, complex)
- **CSV onboarding** (10 routes, ~1500 LoC; multi-stage
  validate+commit; F1-probe heavy)
- **Email failures + PM impact** (2 routes)
- **Payouts / disputes / payments-history** (4 routes,
  money-adjacent)
- **OTP** (5 routes)
- **PM property invitations** (7 routes)

### Admin-surface route slices still uncovered

```
admin.ts                 1514  NO TESTS
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

**Recommended next picks for S358 (if continuing chain):**

1. **landlords.ts payouts + disputes + payments-history**
   — money-adjacent slice (3 of N for landlords arc); ~4
   routes, ~175 LoC. F1-probe candidate (SQL-heavy
   payment summary rollups).
2. **admin.ts** (1514, NO TESTS) — third-biggest
   unwalked file. First slice of multi-session arc.
3. **landlords.ts CSV onboarding slice** — biggest
   remaining landlords.ts slice (10 routes, ~1500 LoC).
   Likely high bug-yield given complexity.
4. **books.ts** (1330, NO TESTS) — GAM Books slice.

### Architectural / non-test (carried)

- **Unicode-capable font in flexsuitePdf** — open since
  S333.
- **responsibleParty source-comment drift fix** —
  one-liner.

### Hardening flagged (no live risk, carried)

- **action.url scheme validation in adminNotifications** —
  flagged S344.

### Vendor-blocked / walkthrough-blocked / dev-team scope

(All unchanged from S356.)

## Items deferred (cross-session docket, post-S357)

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
- **landlords.ts remaining: POS customers + FlexCharge + tenant onboarding + CSV imports + payouts/disputes + OTP + pm property invitations**
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

## What S358 should target

Bug-yield over the last 11 sessions:
- S347 (POS inventory): 2 / 10
- S348 (maintenance-portal): 5 / 15
- S349 (scopes): 1 / 18
- S350 (bookings): 0 / 8
- S351 (entryRequests): 1 / 13
- S352 (pm slice 1): 0 / 17
- S353 (pm design follow-ups): 0 / 4
- S354 (units): 1 / 14
- S355 (properties): 1 / 16
- S356 (landlords slice 1): 0 / 15
- S357 (landlords /me/todos): 0 / 10

Running 11-session average: ~1.0 bugs/session, ~3.6%
per-test rate. Bug-yield has tapered — the last 4
sessions yielded 1 bug total (S355's GROUP BY drift).
The remaining unwalked surfaces are dominated by recent
S188-S356 hardening work which holds up under test.

If continuing chain: **landlords.ts payouts + disputes
slice** is the highest-yield candidate (money-adjacent
SQL rollups; smaller scope than CSV onboarding for a
single session).

If clearing for fresh context: per memory note, start
S358 with the **Checkr API integration in background.ts**
before returning to the test sweep.

---

End of S357 handoff. Closed clean. 910 tests / 46
files / 0 failures. landlords.ts /me/todos rollup
covered including S183 PM-delegation filter regression
pin. 0 production bugs — S183 hardening held up under
the full probe matrix. Next session priority is Checkr
API wire-up per the saved memory note.
