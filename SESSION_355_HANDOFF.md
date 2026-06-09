# Session 355 — closed

## Theme

Picked `properties.ts` (1025 lines, NO TESTS) per the S354
recommendation. Natural companion to S354's units.ts slice
— same admin-surface profile, larger surface, never tested.
Sliced: companies CRUD + fee schedules + late-fee policy
PATCH + allocation-rule PATCH + PM assignment + manager
assignment guards.

The slice surfaced **1 production bug — and it's a real
SQL crash on the most-hit endpoint in the file**: GET
/api/properties has been returning 500 with "column r.id
does not exist" on every call where any property has an
allocation_rule row. Properties get an allocation_rule
on create (line 137-149 of POST /), so this 500 fires
for the landlord PropertiesPage as soon as the landlord
has at least one created property. Likely-broken-since
the schema dropped `id` from `property_allocation_rules`
(PK is `property_id` 1:1 with properties).

How did this go unnoticed? Pure dev-data-only assumption
— the dev seeds may not have triggered the GROUP BY r.id
path (e.g., seeded properties without allocation rules
via direct DB writes), and the landlord PropertiesPage
walkthrough may have been on data sets that pre-dated the
schema change. Classic unwalked-admin-surface bug.

16 new test cases pin the slice, including the F1 fix
regression (the GET / landlord-scoped test creates
properties via the route — which writes allocation rules
— then asserts the list returns 200, which validates
the post-fix GROUP BY).

Suite at S354 close: **869 / 43 files**.
Suite at S355 close: **885 / 44 files** (+16 cases, +1
file).

Zero tsc regressions, zero production regressions.

## Items shipped

### Bug fix (1)

**F1 — GET /api/properties 500 on every call with an
allocation rule**
- `properties.ts:23-41` — `GROUP BY r.id` changed to
  `GROUP BY r.property_id`. The underlying primary key of
  `property_allocation_rules` is `property_id` (1:1 with
  properties); the route was written before/after a
  schema change and never caught the drift.
- Pre-fix: every list call with at least one allocation-
  rule-having property → 500 with raw postgres error
  "column r.id does not exist". Landlord PropertiesPage
  effectively dead.
- Test "landlord-scoped: own properties only" pins the
  fix: creates properties via the route (which inserts
  allocation rules in the same txn), then asserts the
  list returns 200 with the right scope.

### Test coverage — 16 cases / 9 describe blocks

New file: `apps/api/src/routes/properties.test.ts`

**POST /api/properties — create (3)**
- Happy path: property + allocation rule row in same txn;
  S116 bankingFeePayer back-compat mirrors into ach + card
- Missing both ach/card + bankingFeePayer in
  allocationRule → 400 (zod refine catches)
- Duplicate address from same landlord → review_status
  flips to 'pending_review' + property_duplicate_flags
  row written

**GET /api/properties (1)**
- F1 regression pin: landlord-scoped, own properties only,
  list returns 200 (validates the GROUP BY fix)

**GET /api/properties/:id (1)**
- Cross-landlord property → 403

**POST /api/properties/:id/fee-schedule (2)**
- Happy + upsert (ON CONFLICT DO UPDATE): re-POST same
  fee_type updates amount; exactly one row persists
- Cross-landlord property → 403

**PATCH /api/properties/:id — late-fee accrual all-or-
nothing (2)**
- Partial accrual config (amount only) → 400 with
  specific error message
- Full accrual triple (amount + type + period) → 200;
  fields persist

**PATCH /api/properties/:id/allocation-rule (3)**
- Happy: flip ach_fee_payer to tenant
- Empty body → 400 "No allocation-rule fields supplied"
- ownerBankAccountId belonging to different user → 403
  (validates the same-user check)

**PATCH /api/properties/:id/pm-assignment (2)**
- pmFeePlanId without pmCompanyId → 400 (mutual
  consistency)
- pm_company missing bank_account_id → 409 (S110 defense-
  in-depth check)

**PATCH /api/properties/:id/manager — PM conflict guard (2)**
- Cannot set manager while pm_company_id is assigned →
  409 even when reverting to owner (the PM company takes
  precedence in the resolver, so individual manager is
  meaningless)
- Non-scoped target user → 400 "not a property_manager
  scope holder"

### Surfaces NOT covered (out of slice)

- `/:id/units/bulk` — mechanical INSERT loop with unit-
  number generation
- Unit photos upload — multer disk write; needs file-
  system fixtures
- `/listings` / `/listings/preview` public — multi-table
  JOIN, photo-count gate; mostly covered by /:id/get
  scope semantics
- `/apply` public — straightforward INSERT
- `/applications` listing — mechanical SELECT
- `/:id/eligible-managers` — joins + filtering; OK to skip

### Test infra additions

`dbHelpers.cleanupAllSchema` extended with `DELETE FROM
unit_applications`. unit_applications FKs units (SET NULL)
+ landlords (SET NULL), so rows survive parent deletes
and accumulate across tests. unit_photos /
property_fee_schedules / property_duplicate_flags all
CASCADE via units / properties.

## Files touched

```
apps/api/src/routes/
  properties.ts             (+6 -1 lines: F1 fix)
  properties.test.ts        (NEW — 345 lines, 16 cases)

apps/api/src/test/
  dbHelpers.ts              (+5 lines: unit_applications cleanup)
```

No migrations. No schema changes. No frontend changes. No
shared-package changes.

## Decisions made during build

| Question | Decision |
|---|---|
| F1 fix posture — change GROUP BY or drop r.id from the SELECT shape? | **Change GROUP BY.** to_jsonb(r.*) is the right shape (one allocation_rule per property, returned as a nested object). The bug was just a stale PK reference. property_id is functionally dependent on the join because property_allocation_rules' PK IS property_id, so postgres accepts the GROUP BY without complaint. |
| Re-grep all routes for `r.id` GROUP BY drift in case F1's class is wider? | **Targeted — checked properties.ts only.** The crash signature is unique to this route's shape (LEFT JOIN to a table with no `id` column, aggregating with GROUP BY r.id). Doing a codebase sweep here would be speculative; the test slice for any other file would catch the same shape if it exists. |
| Run a probe past the obvious surfaces for additional F-class bugs? | **No probe needed.** F1 surfaced naturally on the first test of the obvious list endpoint. Other unique-shape endpoints (PATCH /allocation-rule, /:id/manager, /:id/pm-assignment) have explicit defensive checks tested here. Probe time better spent on next slice. |
| Cleanup posture — explicit DELETE for all 4 child tables, or rely on CASCADE? | **CASCADE for 3, explicit for unit_applications.** Only unit_applications has SET NULL on both FK sides (units + landlords), so rows leak. The other 3 CASCADE on parent delete. Explicit comment in the helper explains the choice. |
| Mock the duplicate-flag detection block (it does a try/catch + non-fatal logger)? | **Let it run.** The duplicate-detection logic is part of POST /'s contract per the comment "Silent duplicate-address check → flags for admin review." The test seeds two properties with the same address and asserts both the review_status flip AND the property_duplicate_flags row. Real behavior coverage. |
| Test pm-assignment without seeding a complete pm_companies + pm_fee_plans flow? | **Direct INSERT.** The slice's focus is the route's cross-table invariant checks (fee plan must belong to company, company must have bank account, etc.). A full PM-company seed via the pm.ts routes would be 4-5 extra route calls per test for fixtures; direct INSERT into pm_companies is 1 line and exercises the same invariant code paths. |
| Test late-fee accrual all-or-nothing with both directions (partial set + partial clear)? | **Just partial-set.** The all-or-nothing validation uses a final-state check that handles both directions identically (the same accrualSetCount comparison applies to both). One test pins the contract; redundant directionality testing adds nothing. |

## Verification

- `npx tsc --noEmit` clean on apps/api (0 errors).
- `npm test` in apps/api: **885 tests across 44 files, 0
  failures**, ~468s.
- 16 new test cases (`properties.test.ts`).
- 1 production bug fix (`properties.ts` F1 — GET / GROUP BY).
- 0 production regressions.

No frontend touched, no shared-package touched.

## Items deferred — what S356 could target

### Admin-surface route slices still uncovered

After S355, the surface map (sorted by bug-yield
expectations):

```
landlords.ts             3817  NO TESTS  ← biggest unwalked file
admin.ts                 1514  NO TESTS
tenants.ts               1326  NO TESTS
books.ts                 1330  NO TESTS
background.ts            1065  NO TESTS  ← Checkr-blocked, see memory
properties.ts (rest)     ~ 350  units/bulk + photos + listings + apply + applications
pm.ts (rest)             ~ 600  property invitations + Connect + payouts + drilldown
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

**IMPORTANT for next fresh-context session:** Memory note
`project_checkr_access_unblocked.md` says next-session
priority is to wire `background.ts` to live Checkr API
(Nic just got partner credentials 2026-05-26). That work
is **not** a test slice — it's a real product integration
that unblocks OTP onboarding. Do that FIRST in the next
fresh-context session, then return to the test sweep.

**Recommended next picks for S356 (in current session
chain, if continuing):**

1. **`landlords.ts`** (3817, NO TESTS) — biggest unwalked
   file. First slice of multi-session arc. Bug-yield
   expected very high. Pick a well-bounded surface
   (signup / profile / Connect / properties-management).
2. **`tenants.ts`** (1326, NO TESTS) — largest non-admin
   file. Multi-slice candidate.
3. **`books.ts`** (1330, NO TESTS) — GAM Books
   bookkeeping. Cleared from quarantine S145.
4. **`pm.ts` property invitations slice** — continue PM
   arc; self-contained.

### Architectural / non-test (carried)

- **Unicode-capable font in flexsuitePdf** — open since
  S333.
- **responsibleParty source-comment drift fix** —
  one-liner.

### Hardening flagged (no live risk, carried)

- **action.url scheme validation in adminNotifications** —
  flagged S344.

### Vendor-blocked / walkthrough-blocked / dev-team scope

(All unchanged from S354.)

## Items deferred (cross-session docket, post-S355)

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

## What S356 should target

Bug-yield over the last 9 sessions:
- S347 (POS inventory): 2 / 10
- S348 (maintenance-portal): 5 / 15
- S349 (scopes): 1 / 18
- S350 (bookings): 0 / 8
- S351 (entryRequests): 1 / 13
- S352 (pm slice 1): 0 / 17
- S353 (pm design follow-ups): 0 / 4
- S354 (units): 1 / 14
- S355 (properties): 1 / 16

Running 9-session average: ~1.2 bugs/session, ~4.5% per-
test rate. **S355's bug was significant** — a runtime 500
on the most-hit endpoint, latent because the schema
change post-dated the route's GROUP BY. Exactly the
class of bug the sweep was designed to catch.

If continuing the chain immediately:
**Top recommendation: `landlords.ts`** (3817 lines).
Biggest unwalked file in the codebase. Multi-session arc.
Pick a single slice (signup / Connect / properties-mgmt /
profile-edit). Bug-yield expected very high given the
size + age + lack of test coverage.

If clearing for fresh context: per memory note, start
S356 with the **Checkr API integration in background.ts**
before returning to the test sweep.

---

End of S355 handoff. Closed clean. 885 tests / 44 files /
0 failures. properties.ts companies + fee-schedule +
allocation-rule + pm-assignment + manager slice covered.
1 real bug caught + fixed (F1: GET / GROUP BY drift —
500 on every list call with allocation rules).
properties.ts most-hit endpoint now working again.
