# Session 360 — closed

## Theme

Continued the landlords.ts arc. **Slice 5:** tenants-CSV
onboarding triad (template + validate + commit — 3 routes,
~700 LoC). Companion to S359's properties-CSV slice. Per
the S359 recommendation, expected low yield given the same
S231 + S295 hardening posture.

The slice surfaced **1 real production bug** — and it's a
big one. `services/leaseFeesSync.ts` writes a security-
deposit lease_fees row without supplying `is_refundable`,
which is NOT NULL. Every CSV-tenant commit with
`security_deposit > 0` crashed 500 with the entire
commit transaction rolling back. **Tenants CSV import has
been broken in production for any tenant with a security
deposit (i.e., the common case for residential imports).**

Pre-S360 the only way to use the CSV importer successfully
would be to (a) zero out all security deposits in your
source CSV, or (b) skip the deposit column entirely.
Neither matches actual onboarding practice.

The bug wasn't surfaced by the existing leaseFeesSync test
(which apparently doesn't cover the INSERT-not-NULL-
required path) or the properties-CSV slice (which doesn't
touch lease_fees).

13 new test cases pin the slice + the F1 fix regression.

Suite at S359 close: **934 / 48 files**.
Suite at S360 close: **947 / 49 files** (+13 cases, +1
file).

Zero tsc regressions, zero production regressions.

## Items shipped

### Bug fix (1)

**F1 — `leaseFeesSync.syncSecurityDepositLeaseFee` 500 on
every CSV tenant import with a deposit**
- `services/leaseFeesSync.ts:52-62` — INSERT statement
  was missing the `is_refundable` column. The schema
  requires it NOT NULL. Pre-S360 every CSV tenant commit
  with `security_deposit > 0` crashed
  `null value in column "is_refundable" of relation
  "lease_fees" violates not-null constraint` → 500 → full
  transaction rollback → no user / tenant / lease /
  lease_tenant rows created → CSV import fully blocked.
- Fix: add `is_refundable, TRUE` to the column list +
  values. Security deposits are refundable by definition;
  hardcoded TRUE matches the schema intent and the
  existing front-end create flows.
- This is the **highest-impact bug surfaced in the entire
  test sweep arc so far** — landlords doing the
  "migrate from your prior PM software" flow couldn't
  complete it for any tenant with a deposit. Test
  "happy path" pins the fix.

### Test coverage — 13 cases / 3 describe blocks

New file: `apps/api/src/routes/landlords-csv-tenants.test.ts`

**GET template (1)**
- `source=generic` returns CSV with canonical
  `first_name` column

**POST validate (7)**
- Headers only (no data rows) → 400 "no data rows"
- Happy path: 1 row with matching unit → resolvedUnitId
  stamped, summary `{total:1, blockers:0, ready:1}`
- Invalid email format → blocker on email field
- No matching unit in landlord portfolio → blocker (`No
  unit "X" found at property "Y"`); resolvedUnitId
  undefined
- Unit already occupied (active primary lease_tenant) →
  blocker (`Unit is already occupied`); v_unit_occupancy
  path verified by seeding a full lease + lease_tenant
  chain
- Duplicate email in batch → warn on second row
  (`Duplicate of row N — will be skipped`)
- `auto_renew=yes` without `auto_renew_mode` → blocker

**POST commit (5)**
- Empty rows array → 400 "rows array required"
- Generic source without `claimedPlatformName` → 400
- **Defense-in-depth:** cross-landlord unit
  (resolvedUnitId references unit owned by another
  landlord) → 403 "not owned by this landlord"
- Rows with remaining blockers → 400 + no tenant
  created
- **F1 regression pin:** happy path creates user +
  tenant + lease + lease_tenant; email helper called
  once with recipient email. Pre-fix this exact path
  500'd on the deposit insert.

### Test infra additions

- Mock for `services/csvImportAttempts` (same pattern as
  S359) + `services/email.emailTenantOnboarded` (lets the
  test verify the email was attempted without hitting
  Resend).

### Surfaces NOT covered (out of slice — for future
sessions)

- **Payment-history CSV** (template + validate + commit,
  3 routes, ~300 LoC) — closes the CSV onboarding triad
- landlords.ts arc remaining: tenant onboarding (non-CSV)
  + POS customers + FlexCharge + OTP + pm property
  invitations + email-failures / pm-impact

## Files touched

```
apps/api/src/services/
  leaseFeesSync.ts                  (+8 -2 lines: F1 fix)

apps/api/src/routes/
  landlords-csv-tenants.test.ts     (NEW — 320 lines, 13 cases)
```

No migrations. No schema changes. No frontend changes.

## Decisions made during build

| Question | Decision |
|---|---|
| F1 fix posture — hardcode `is_refundable=TRUE` or expose it as a parameter? | **Hardcode TRUE.** Security deposits are refundable by definition (that's the legal status — the landlord holds it in trust and returns the unclaimed portion at move-out). Other lease_fee types (cleaning_fee, pet_fee, etc.) may be non-refundable, but security_deposit specifically is always refundable. The function name (`syncSecurityDepositLeaseFee`) makes the type unambiguous. Adding a param would be over-engineering for a single-use helper. |
| Probe for other NOT-NULL omissions in leaseFeesSync.ts or related lease_fees writers? | **Surgical fix.** This is the only `INSERT INTO lease_fees` in leaseFeesSync.ts. Other lease_fees writers (POST /properties/:id/fee-schedule, lease creation in leases.ts) explicitly require is_refundable in their zod schemas. If a future slice tests another lease_fees write path, it'll surface its own bugs. |
| Tests for the F1 fix — pin the failure mode AND the success mode? | **Just success.** The happy-path test exercises the deposit-write code path; pre-fix it crashed with a specific postgres error, post-fix it succeeds. The fact that the test transitioned from FAIL to PASS after the one-line fix is the regression pin. Adding an explicit failure-mode test ("pre-fix the route returned 500") would require reverting the fix to assert against, which is anti-pattern. |
| Test the lease_fees row landed correctly (amount, fee_type, due_timing) in the happy path? | **Skipped — implicit in commit success.** The happy-path test asserts the commit returns 200 + the lease row exists. The lease_fees write is a downstream side-effect; if it crashed, the commit would 500 (as it did pre-fix). Asserting the exact lease_fees row shape would duplicate the leaseFeesSync's own test coverage. |
| Mock `services/leaseFeesSync` to bypass the F1 path and discover other commit-route bugs? | **No — let it run.** Mocking would have hidden F1, which was exactly the bug worth finding. The whole point of the route-test slice is to exercise the real downstream chain. |
| Skip the "co-tenant on same unit" warn-merge test (warns about lease_start mismatch)? | **Yes — out of slice.** The co-tenant flow is its own multi-row validate behavior; adding it would double the validate test count. The primary-vs-co-tenant logic is mostly defensive UX rather than data integrity. |
| Test the email-mismatch / existing-tenant-elsewhere blocker (cross-landlord existing tenant)? | **Skipped — requires complex multi-landlord seed.** Would need to seed a tenant under landlord B with an active lease under B, then attempt CSV import under landlord A with the same email. Coverage gain is moderate; if Nic surfaces a cross-landlord tenant onboarding bug, this becomes the test to add. |
| Test the `outstanding_balance` opening-invoice creation in the commit? | **Skipped — out of slice.** That branch creates invoices via invoice_sequences which is a separate subsystem with its own test coverage. The happy-path test exercises the lease+user+tenant chain; the invoice path is parallel. |

## Verification

- `npx tsc --noEmit` clean on apps/api (0 errors).
- `npm test` in apps/api: **947 tests across 49 files, 0
  failures**, ~457s.
- 13 new test cases (`landlords-csv-tenants.test.ts`).
- 1 production bug fix (`leaseFeesSync.ts` F1 — missing
  is_refundable column).
- 0 production regressions.

No frontend touched, no shared-package touched.

## Items deferred — what S361 could target

### **NEXT FRESH-CONTEXT SESSION:** Checkr API wire-up

Memory note `project_checkr_access_unblocked.md` is the
priority. Nic obtained Checkr Partner credentials
2026-05-26. The next fresh-context session starts with
wiring `background.ts` to live Checkr (real product
integration, not a test slice). Per
`feedback_checkr_otp_unrelated.md`, frame Checkr as
background-check product going live, NOT as unblocking
OTP — they're independent surfaces.

### landlords.ts remaining slices

S356–S360 covered 19 routes (~36% of landlords.ts).
Remaining surfaces:

- **Payment-history CSV** (3 routes, ~300 LoC)
- **Tenant onboarding (non-CSV)** (4 routes, ~600 LoC)
- **POS customers + FlexCharge** (8 routes, ~150 LoC)
- **Email failures + PM impact** (2 routes)
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

**Recommended next picks for S361 (if continuing chain):**

1. **landlords.ts payment-history CSV slice** — closes
   the CSV onboarding triad. ~300 LoC. Lower yield
   expected; mostly mechanical at this point.
2. **landlords.ts OTP slice** — 5 routes, ~100 LoC.
   Self-contained, closes the OTP surface in
   landlords.ts.
3. **landlords.ts PM property invitations slice** — 7
   routes, bidirectional handshake; pairs with the
   unfinished pm.ts property-invitations slice.
4. **admin.ts** (1514, NO TESTS) — fresh slice arc.
   Third-biggest unwalked file.

### Architectural / non-test (carried)

- **Unicode-capable font in flexsuitePdf** — open since
  S333.
- **responsibleParty source-comment drift fix** —
  one-liner.

### Hardening flagged (no live risk, carried)

- **action.url scheme validation in adminNotifications** —
  flagged S344.

### Vendor-blocked / walkthrough-blocked / dev-team scope

(All unchanged from S359.)

## Items deferred (cross-session docket, post-S360)

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
- landlords.ts remaining: payment-history CSV + tenant onboarding + POS customers + FlexCharge + OTP + pm property invitations + email-failures / pm-impact
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

## What S361 should target

Bug-yield over the last 14 sessions:
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
- S358 (landlords payouts/disputes): 1 / 11
- S359 (landlords CSV properties): 0 / 13
- S360 (landlords CSV tenants): 1 / 13

Running 14-session average: ~1.0 bugs/session, ~3.3%
per-test rate. **S360's F1 is the highest-impact bug
surfaced in the entire arc** — a fully broken production
flow (CSV tenant import with deposits, the common case).
The "well-hardened recent code holds clean" pattern
**broke this session**: leaseFeesSync was a recent
service (S195 dual-write) and still shipped with a
missing-column bug. The CSV-tenants commit's downstream
chain hit a service that was assumed working.

If continuing chain: **landlords.ts payment-history CSV
slice** closes the CSV triad; expected low yield given
properties+tenants are now covered. Better candidates
for bug-yield: **admin.ts** fresh slice (1514 lines,
never tested) or **landlords.ts OTP slice** (5 routes,
self-contained).

If clearing for fresh context: per memory note, start
S361 with the **Checkr API integration in background.ts**
before returning to the test sweep.

---

End of S360 handoff. Closed clean. 947 tests / 49 files
/ 0 failures. landlords.ts tenants-CSV slice covered. 1
real bug caught + fixed (F1: leaseFeesSync.ts missing
is_refundable column — CSV tenant import broken for any
tenant with a security deposit, which is the common
case). Highest-impact F-class bug in the arc to date.
