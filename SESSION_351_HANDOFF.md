# Session 351 — closed

## Theme

Continuing the admin-surface route-test sweep. Picked
`entryRequests.ts` (439 lines, NO TESTS) — landlord-initiated
unit entry workflow per the credit-ledger spec (CLAUDE.md).
6-endpoint surface: create / get / list / respond / record-
entry / cancel.

The slice surfaced **1 production bug** — a raw-500 leak on
the create path when the caller passes a tenantId that
doesn't reference an existing tenant row. Pre-S351 the
INSERT crashed on the `unit_entry_requests_tenant_id_fkey`
constraint with a postgres error message bubbled to the
client as a 500. UX-class bug — not security — but the kind
of thing a landlord UI would surface as "Internal Server
Error" when the actual cause is a stale/wrong UUID.

13 new test cases pin the slice. Coverage includes:
- The S236-style scope guard via loadRequest (tenant can't
  see another tenant's request; landlord can't see another
  landlord's)
- Lifecycle pinning: pending → granted/denied → completed/
  breached → terminal-status protection
- Cross-landlord create forbidden
- F1 fix: 404 instead of 500 on bad tenantId

Suite at S350 close: **821 / 40 files**.
Suite at S351 close: **834 / 41 files** (+13 cases, +1 file).

Zero tsc regressions, zero production regressions.

## Items shipped

### Bug fix (1)

**F1 — POST / with random tenantId UUID → 500 instead of 404**
- `entryRequests.ts:71-78` — added pre-INSERT existence check
  for `tenants.id = $tenantId`. Returns 404 "Tenant not
  found" instead of letting the INSERT crash on the FK.
- Pre-fix: any landlord create request with a stale or wrong
  tenant uuid produced a 500 with raw postgres error message
  `insert or update on table "unit_entry_requests" violates
  foreign key constraint "unit_entry_requests_tenant_id_fkey"`.
- Test `S351 F1: random tenantId UUID → 404 "Tenant not
  found"` pins the fix.

### Test coverage — 13 cases / 6 describe blocks

New file: `apps/api/src/routes/entryRequests.test.ts`

**POST / — create (4)**
- Happy path: pending row, notice_window math (36h-out
  window meets 24h default), notifyEntryRequestNew fired
- F1: random tenantId → 404 (post-fix); no row created
- Cross-landlord unit (landlord A's token, landlord B's
  unit) → 403; no row created
- Window end before start → 400

**POST /:id/respond (3)**
- Tenant grants happy: status→granted, response row
  inserted with reason, emitEntryRequestResponseEvents
  called with the right args (tenantId, decision)
- Wrong tenant attempting to respond (cross-fixture) → 403;
  status stays pending; emitter not called
- Re-respond on non-pending status → 409 (idempotency
  guard)

**POST /:id/record-entry (3)**
- Within-window + granted → outcome=compliant, status=
  completed, notes persisted, emitter receives
  grantedDecision='granted'
- Outside-window or denied → outcome=breach, status=
  breached, emitter receives grantedDecision='denied'
- Cannot record on cancelled request → 409; emitter
  not called

**POST /:id/cancel (1)**
- Landlord cancels pending → status=cancelled

**loadRequest scope guard via GET /:id (2)**
- Tenant fetching another tenant's request → 403
- Landlord fetching another landlord's request → 403

### Test infra additions

`dbHelpers.cleanupAllSchema` extended with
`unit_entry_request_responses` + `unit_entry_requests`.
Responses CASCADE on request delete; explicit clear keeps
the FK chain order obvious for future readers.

### Surfaces NOT covered

- GET / list endpoint — defensive in-memory filter same as
  bookings.ts (S350); mechanical coverage with low marginal
  yield
- emitter side-effects (credit_events rows landing,
  attestation_source / dimension_tags) — covered by
  creditLedgerEmitters' own suite; this slice mocks the
  emitters to test the route contract

## Files touched

```
apps/api/src/routes/
  entryRequests.ts          (+7 lines: F1 fix)
  entryRequests.test.ts     (NEW — 290 lines, 13 cases)

apps/api/src/test/
  dbHelpers.ts              (+5 lines: entry-request tables cleanup)
```

No migrations. No schema changes. No frontend changes. No
shared-package changes.

## Decisions made during build

| Question | Decision |
|---|---|
| Mock the credit-ledger emitters or let them run and verify credit_events rows land? | **Mock.** The credit-ledger appendEvent + hash-chain math has its own coverage; replicating it here would duplicate effort and tie this slice to the credit-ledger schema (a refactor in event_data shape would break route tests for no good reason). The slice tests the route contract: did the emitter get called with the right args? Mocked vi.fn captures the args. |
| F1 fix posture — pre-check tenant existence, or catch the 23503 and translate? | **Pre-check.** Cleaner code path; one fewer try/catch nest; matches the explicit-check pattern used at line 67 (`if (!unit) throw 404`). Catching the constraint name in an error handler works but requires knowing the exact constraint name (would need updating if a future migration renames it). Pre-check is more robust. |
| Probe for a 2nd bug after F1, or stop at 13 tests? | **Stop.** The other likely-suspect — unit_id FK race — is already covered by the explicit pre-check at line 67 (`if (!unit) throw 404`). Lease_id is nullable so no FK concern. The recordSchema validates enteredAt as z.string() (not z.string().datetime()), but new Date(invalid) produces NaN which the within-window check handles defensively (NaN comparisons all false → breach outcome, which is the safer default). No additional bug worth pinning. |
| F1 fix — also validate the tenant has an active lease for the unit? | **No — out of scope.** The current design lets the landlord initiate an entry request against any unit/tenant pair under their landlord_id. Whether the tenant actually leases that unit is a product question (Nic decides whether to gate it). The F1 fix only translates a known crash into a clean error; adding a lease-membership check would be design creep. |
| Test the notice_window_meets_default=false path (short-notice request)? | **Skipped — implicit in the happy-path test.** The test seeds a 36h-out window and asserts meets_default=true. The negation (true→false on a <24h window) is mechanical math. Could add but yield is low. |
| Mock notifyEntryRequest* or let them fire (the `.catch(...)` swallows errors anyway)? | **Mock.** They write to the notifications table and try to send email via Resend. Letting them run would pollute the DB and risk a Resend round-trip in dev. The wrapping `.catch(...)` only catches throws, but mocks return cleanly anyway. |
| Pull the landlord_id forward to the SELECT (defense-in-depth) in loadRequest? | **No — out of scope.** loadRequest's current shape (load → check → throw) is the same pattern as bookings.ts and matches the existing house style. Not a bug, not a regression risk. Pure refactor, no test would change. |

## Verification

- `npx tsc --noEmit` clean on apps/api (0 errors).
- `npm test` in apps/api: **834 tests across 41 files, 0
  failures**, ~396s.
- 13 new test cases (`entryRequests.test.ts`).
- 1 production bug fix (`entryRequests.ts:71-78`).
- 0 production regressions.

No frontend touched, no shared-package touched.

## Items deferred — what S352 could target

### Admin-surface route slices still uncovered

```
landlords.ts             3817  NO TESTS  ← biggest unwalked file
admin.ts                 1514  NO TESTS
tenants.ts               1326  NO TESTS  ← largest non-admin
books.ts                 1330  NO TESTS
pm.ts                    1078  NO TESTS  ← multi-slice candidate
background.ts            1065  NO TESTS
properties.ts            1025  NO TESTS
credit.ts                 839  NO TESTS
units.ts                  513  NO TESTS  ← bookings CRUD here
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

**Recommended next picks for S352:**

1. **`pm.ts`** (1078, NO TESTS, multi-slice) — third-party
   PM company subsystem. CLAUDE.md flagged feature-complete
   (S157). Slice by feature: companies CRUD / fee plans /
   invitations / monthly accruals. Pick one for a single
   session. Bug-yield likely material (whole subsystem
   never tested).
2. **`units.ts`** (513, NO TESTS) — bookings CRUD lives
   here (per-unit POST/PATCH /bookings — companion to the
   bookings.ts list endpoint covered in S350). Closes that
   gap fully.
3. **`landlords.ts`** (3817, NO TESTS) — biggest file.
   Multi-session arc. Pick a slice: signup / profile /
   Connect onboarding / properties-management.
4. **`pos.ts` inventory remaining surfaces** — vendors /
   tax-rates / discounts / variants CRUD. Lower yield
   since the shape is shared (S347 covered the pattern).

### Architectural / non-test (carried)

- **Unicode-capable font in flexsuitePdf** — open since S333.
- **responsibleParty source-comment drift fix** — one-liner.

### Hardening flagged (no live risk, carried)

- **action.url scheme validation in adminNotifications** —
  flagged S344.

### Vendor-blocked / walkthrough-blocked / dev-team scope

(All unchanged from S350.)

## Items deferred (cross-session docket, post-S351)

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

## What S352 should target

Bug-yield over the last 5 sessions:
- S347 (POS inventory): 2 bugs / 10 tests
- S348 (maintenance-portal): 5 bugs / 15 tests
- S349 (scopes): 1 bug / 18 tests
- S350 (bookings): 0 bugs / 8 tests
- S351 (entryRequests): 1 bug / 13 tests

The 5-session running average is ~1.8 bugs per session,
roughly 10-13% bug-per-test rate. The S350 zero was a small
file with mature defensive shape; expect the rate to stay
material on larger files (pm.ts, landlords.ts, etc.).

**Top recommendation: `pm.ts`** (1078 lines, multi-slice
candidate). The third-party PM subsystem hasn't had any
test coverage since it landed (S107-S112) and the
allocation engine routes the PM cut via Stripe transfers
under the S113 destination-charges rebuild. Slice by
feature: pick `pm.ts → companies CRUD + staff invitations`
as a single session. Bug-yield expected high (whole
subsystem never tested + post-S113 rebuild risk).

Backup: **`units.ts`** (513 lines). Covers the per-unit
booking CRUD that companion-pairs with S350's bookings.ts
slice — closes the booking subsystem to ~100% route
coverage. Moderate yield.

Same posture: launch-blockers are vendor / walkthrough /
dev-team. Marginal launch-risk reduction per session
continues; admin-surface coverage paying off, with bug-
yield variable by file size and prior hardening history.

---

End of S351 handoff. Closed clean. 834 tests / 41 files /
0 failures. entryRequests.ts slice covered including the
credit-ledger workflow lifecycle. 1 bug caught + fixed
(F1: random tenantId 500→404 translation). Bug-yield
pipeline continues at material per-session rate on
unwalked admin surfaces.
