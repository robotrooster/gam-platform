# Session 367 — closed

## Theme — **landlords.ts arc complete**

**Final slice of the landlords.ts arc:** tenant onboarding
(non-CSV) — 5 routes, ~600 LoC. Single-tenant manual
onboarding + the "limbo pool" workflow per S29c-2-A.

The slice surfaced **0 production bugs**. The complete
chain (user + tenant + lease + lease_tenant + activation
email + leaseFeesSync security_deposit dual-write) ran
end-to-end on the first happy-path test — confirming that
the S360 leaseFeesSync F1 fix (the `is_refundable`
missing-column bug) is also healing this path, which had
the same vulnerability before S360.

13 new test cases pin the slice. **landlords.ts arc done
— 49 routes covered across 11 slices** (S356-S367).

Suite at S366 close: **1015 / 55 files**.
Suite at S367 close: **1028 / 56 files** (+13 cases, +1
file).

Zero tsc regressions, zero production regressions.

## landlords.ts arc summary (S356-S367, 11 slices)

| S | Slice | Routes | Cases | Bugs |
|---|---|---|---|---|
| 356 | profile + dashboard + theme + onboarding + deposit-interest | 8 | 15 | 0 |
| 357 | /me/todos rollup (S183 PM-delegation filter) | 1 | 10 | 0 |
| 358 | payouts + disputes + payments-history | 4 | 11 | **1** (F1: ambiguous-column) |
| 359 | CSV onboarding — properties | 3 | 13 | 0 |
| 360 | CSV onboarding — tenants | 3 | 13 | **1** (F1: leaseFeesSync missing is_refundable) |
| 361 | CSV onboarding — payment history | 3 | 13 | 0 |
| 363 | POS customers + FlexCharge | 8 | 12 | 0 |
| 364 | email-failures + pm-impact | 2 | 8 | 0 |
| 365 | OTP | 5 | 11 | 0 |
| 366 | PM property invitations | 7 | 12 | 0 |
| **367** | **tenant onboarding (non-CSV)** | **5** | **13** | **0** |
| **TOTAL** | **49 routes / 11 slices** | | **131 tests** | **2 bugs** |

(S362 admin.ts pivot excluded — that was the wrong-pivot
that triggered the "finish arcs first" memory.)

## Items shipped this session

### Test coverage — 13 cases / 5 describe blocks

New file: `apps/api/src/routes/landlords-tenant-onboarding.test.ts`

**POST /me/onboard-tenant (5)**
- Happy: full chain — user + tenant + lease (active,
  fixed_term, needs_review=true, lease_source='imported')
  + primary lease_tenant + activation email; activation
  URL format `…/accept-invite?token=<64hex>`
- No leaseEnd → lease_type defaults to `month_to_month`
- Cross-landlord unit → 403 "not owned by this landlord"
- Unit already occupied (active primary lease_tenant on
  unit) → 409 "already occupied"
- autoRenew=true with invalid mode → 400

**POST /me/onboard-tenant-pending (2)**
- Happy: user + tenant + pending_tenant_intents row
  (parser_status='not_uploaded'); NO email fired (limbo
  entry doesn't activate)
- Duplicate intent for same tenant → 409 "already in your
  pending pool"

**POST /me/onboard-tenants-csv/commit-pending (2)**
- Empty rows → 400
- Mixed batch: 1 valid row + 1 missing-fields row →
  per-row results array with status `'created' | 'error'`;
  valid row's intent persists (verifies the per-row
  transaction isolation — row failure does NOT roll back
  successful siblings)

**GET /me/pending-tenants (1)**
- Landlord-scoped + resolved intents excluded (the
  `resolved_at IS NULL` filter) + cross-landlord excluded

**DELETE /me/pending-tenants/:intentId (3)**
- Not found / wrong landlord → 404
- Happy safe-to-delete: tenant + user have no other
  active links → all three rows removed
  (`tenantDeleted: true, userDeleted: true`)
- **Tenant has OTHER lease_tenants link → tenant + user
  preserved**, only intent removed. Pins the
  safe-to-delete guard (intent.tenant_id has other
  active lease links → don't cascade-delete the human
  account that's still in use elsewhere)

## Files touched

```
apps/api/src/routes/
  landlords-tenant-onboarding.test.ts   (NEW — 285 lines, 13 cases)
```

No production code touched. No migrations. No schema
changes. No cleanup helper changes
(pending_tenant_intents CASCADE'd via landlords).

## Decisions made during build

| Question | Decision |
|---|---|
| Probe for an F1-class bug given S360's leaseFeesSync revealed a hidden missing-column in this same code path? | **Probed via the happy path — clean now.** S360 fixed leaseFeesSync.ts:53 to include `is_refundable`. The /onboard-tenant route's leaseFeesSync.syncSecurityDepositLeaseFee call would have hit the same bug pre-S360. Post-fix, the happy-path test passes end-to-end. The fix is automatically protecting this route too. |
| Test the "existing user but no tenant row" branch on /onboard-tenant (existingUser truthy but tenant_id null)? | **Skipped — multi-condition edge case.** Would require seeding a users row without a tenants row, then submitting the same email. The existing path branches (existingUser → reuse user / no existing → create user) are exercised by happy + duplicate tests; the third edge (existing user, no tenant) is mechanical. |
| Test the cross-landlord existing tenant 409 directly? | **Skipped — covered by the limbo-entry duplicate test.** Both routes use the same conflict-check helper pattern; one test pins it. Adding a duplicate in /onboard-tenant would be ceremony. |
| Verify the activation URL contains a real 32-byte hex token? | **Yes — pinned format with /^…\/accept-invite\?token=[0-9a-f]{64}$/.** Future change to token generation (e.g., switching to uuid) breaks the regex; explicit pin catches the drift. |
| Mock leaseFeesSync to avoid hitting that path? | **No — let it run.** S360's fix means the path works, and exercising it through this test validates the fix end-to-end via a second consumer. Skipping the real path would miss any future regression. |
| Test the DELETE /pending-tenants race where the safe-to-delete check sees no other links but a concurrent write adds one? | **Out of slice.** Requires SELECT FOR UPDATE locking; current code is read-then-decide (not race-safe but acceptable for a low-volume admin action). Surface for a future hardening pass if it becomes a real issue. |
| Test the PDF cleanup branch (imported_pdf_url unlink)? | **Skipped — file-system fixture.** Would need to seed a real file under uploads/lease-pdfs-pending/ then assert it's gone. Lower yield than the data-side cleanup test. |

## Verification

- `npx tsc --noEmit` clean on apps/api (0 errors).
- `npm test` in apps/api: **1028 tests across 56 files, 0
  failures**, ~555s.
- 13 new test cases (`landlords-tenant-onboarding.test.ts`).
- 0 production bug fixes.
- 0 production regressions.

No frontend touched, no shared-package touched.

## Items deferred — what S368 could target

### **NEXT FRESH-CONTEXT SESSION:** Checkr API wire-up

Memory note `project_checkr_access_unblocked.md` is the
priority. Nic obtained Checkr Partner credentials
2026-05-26. The next fresh-context session starts with
wiring `background.ts` to live Checkr (real product
integration). Per `feedback_checkr_otp_unrelated.md`,
frame Checkr as background-check product going live, NOT
as unblocking OTP.

### Next arc candidates (after landlords.ts complete)

```
admin.ts (rest)          ~ 1265  CSV-import-attempts review queue + income + bulletin + OTP/FlexCharge retry + deposit-portability + connect-readiness + onboarding detail + email failures + audit log + platform claims
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

**Recommended next picks for S368 (if continuing chain):**

1. **admin.ts continue** — pick a remaining admin.ts
   slice (CSV-import-attempts review queue would pair
   with the S359-S361 CSV onboarding triad and close
   the CSV subsystem end-to-end). Per the
   finish-arcs-first memory, the admin.ts arc opened in
   S362 should be the next priority once landlords.ts is
   done.
2. **tenants.ts** (1326, NO TESTS) — biggest remaining
   tenant-facing file. Fresh arc.
3. **books.ts** (1330, NO TESTS) — GAM Books slice.

### Architectural / non-test (carried)

- **Unicode-capable font in flexsuitePdf** — open since
  S333.
- **responsibleParty source-comment drift fix** —
  one-liner.

### Hardening flagged (no live risk, carried)

- **action.url scheme validation in adminNotifications** —
  flagged S344.

### Vendor-blocked / walkthrough-blocked / dev-team scope

(All unchanged from S366.)

## Items deferred (cross-session docket, post-S367)

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
- ~~landlords.ts remaining~~ — **ARC COMPLETE S367**
- admin.ts remaining: CSV-import-attempts review queue + income projection + bulletin + OTP/FlexCharge retry + deposit-portability + connect-readiness + onboarding detail + email failures + audit log + platform claims
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

## What S368 should target

Bug-yield over the last 21 sessions (S347-S367):
- Total: 16 bugs caught / 240 tests written / 11 sessions
  with at least 1 bug

Running 21-session average: ~0.8 bugs/session, ~6.7%
of tests pin a bug. The cumulative test sweep has
covered ~75 routes across 9 files plus full landlords.ts.

**S368 should continue the admin.ts arc** (opened S362,
only 1 slice done). Per the finish-arcs-first memory,
admin.ts has 9 remaining slices and should be completed
before opening another fresh file. Pick the CSV-import-
attempts review queue next — it pairs cleanly with the
S359-S361 CSV onboarding triad to close the CSV
subsystem end-to-end (data side ✓, moderation side
will close).

If clearing for fresh context: per memory note, start
S368 with the **Checkr API integration in background.ts**
before returning to the test sweep.

---

End of S367 handoff. **landlords.ts arc complete after 11
slices (S356-S367, 49 routes, 131 tests, 2 bugs fixed).**
1028 tests / 56 files / 0 failures. Next priority is
finishing the admin.ts arc opened S362.
