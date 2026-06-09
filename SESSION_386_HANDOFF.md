# Session 386 — closed

## Theme

**books.ts arc slice 4 of 5:** journal + transactions +
bills (10 routes — double-entry bookkeeping +
accounts-payable surface).

The slice surfaced **4 production bugs**:
- 3 cross-tenant ID-not-validated bypasses (same pattern
  as S385 bookkeeper-write cluster)
- 1 ALWAYS-500 endpoint (`POST /bills/:id/pay`) broken
  by a Postgres parameter-type ambiguity

All four fixed in the same pass. The /bills/:id/pay
endpoint had been completely non-functional in
production — every call returned 500 with
"inconsistent types deduced for parameter $2."

27 new test cases pin the slice + all 4 fixes.

Suite at S385 close: **1237 / 73 files**.
Suite at S386 close: **1264 / 74 files** (+27 cases, +1 file).
Runtime ~692s.

Zero tsc regressions, zero production regressions.

## Bugs found + fixed

### Bug 1 (HIGH) — POST /journal: cross-tenant balance corruption

**Symptom:** the per-line journal post did `UPDATE
books_accounts SET balance = balance + $1 WHERE id = $2`
with `$2` coming straight from `req.body.lines[].accountId`
— no check that the account belongs to the caller's
landlord. A landlord could pass another landlord's
account_id and mutate that other landlord's financial
state. Worse: the journal_entry header has the caller's
landlord_id, so the entry is invisible to the victim
landlord — they'd just see their account balance
mysteriously drifting with no traceable cause.

**Severity: HIGH — cross-tenant financial corruption.**

**Fix:** validate every line's accountId belongs to the
caller's landlord BEFORE the transaction begins. Admin
callers (`lid === null`) retain cross-landlord authority.
The check is a single SELECT with `WHERE id = ANY($1::uuid[])
AND landlord_id = $2`, returning the full set if all valid.
The pre-existing per-line `if (!line.accountId)` guard
moved up to the validation block (so missing-accountId
still 400s the same way).

### Bug 2 (MED) — POST /transactions: cross-tenant accountId pollution

**Symptom:** `accountId` from body inserted into
books_transactions with no scope check. The `GET
/transactions` LEFT JOIN on account_id would surface the
wrong account_name when the txn pointed at another
landlord's account. Cosmetic in isolation but pollutes
the reporting surface.

**Fix:** if `accountId` is provided AND caller is non-
admin, verify it belongs to caller's landlord (403 if
not).

### Bug 3 (MED) — POST /bills: cross-tenant vendor AP corruption

**Symptom:** `vendorId` from body used in the follow-on
`UPDATE books_vendors SET ap_balance = ap_balance + $1
WHERE id = $2`. A landlord could attach a bill to another
landlord's vendor and bump the wrong AP balance. Also
applies to optional `accountId` on the same route (joins
to books_accounts).

**Fix:** validate `vendorId` AND `accountId` (if provided)
both belong to caller's landlord. 403 on mismatch.

### Bug 4 (CRITICAL) — POST /bills/:id/pay always returns 500

**Symptom:** the SQL used `$2` in two contexts —
`status=$2` (varchar column) and `CASE WHEN $2='paid'`
(literal compare). Postgres couldn't deduce a single
type for the parameter and threw:
> inconsistent types deduced for parameter $2:
> text versus character varying (code 42P08)

Every call to /bills/:id/pay returned 500. **The
bill-payment endpoint has been completely broken in
production.** Discovered by the first /pay test in
this slice — would have been silently dead before.

**Fix:** compute the `paid_at` clause in JS (`NOW()` or
`paid_at` based on `newStatus`) and interpolate into the
SQL string. Removes the dual-context $2 reuse. Single
$2 binding now flows only to the column assignment.

This is the **third "endpoint silently broken" bug** of
the cross-portal arc (after S377 invite requireAuth-gate +
S381 charge-account schema-drift). Pattern: routes with
no test coverage can sit broken indefinitely; the test
sweep IS the bug-discovery mechanism.

## Finding flagged (NOT fixed)

### POST /bills/:id/pay does NOT cap overpayment

If `req.body.amount > bill.amount - bill.amount_paid`:
- `amount_paid` exceeds `amount` (no max-cap)
- `status` flips to 'paid' (via `>=` check)
- `vendor.ap_balance` correctly floors at 0 via
  `GREATEST(0, ...)`
- `vendor.ytd_paid` is **over-credited** by the overpay
  amount

Product call required: should over-pays (a) be rejected
with 400, (b) cap at `bill.amount - amount_paid`, (c)
record as a vendor credit / future-bill advance, or (d)
be allowed as-is (the current behavior, with the
ytd_paid arithmetic accepted). Not fixed in S386 —
needs Nic's pick.

## Items shipped

### Test coverage — 27 cases / 9 describe blocks

New file: `apps/api/src/routes/books-journal-tx-bills.test.ts`

**Journal — 11 cases**
- GET landlord-scoped + line_count populated
- GET /:id unknown 404, cross-landlord 404, happy with
  account code/name join (3)
- POST validation: missing fields, debits≠credits, zero
  amount, missing accountId on a line (4)
- POST **S386 fix**: cross-tenant accountId → 403, no
  rows written (1)
- POST happy: balanced entry posts, account balances
  update correctly (asset debit side +amount, income
  credit side -amount per signed-balance convention) (1)
- Void: unknown 404, happy reverses balances,
  already-voided 400 (3)

**Transactions — 5 cases**
- GET landlord-scoped + type filter
- POST validation: missing fields
- POST **S386 fix**: cross-tenant accountId → 403, no
  row written
- POST happy: creates tx with valid accountId
- PATCH /reconcile: cross-landlord blocked → 404; happy
  flips reconciled=TRUE + stamps reconciled_at

**Bills — 11 cases**
- GET landlord-scoped + vendor_name joined
- POST validation: missing fields
- POST **S386 fix**: cross-tenant vendorId → 403, B
  vendor ap_balance untouched (pre/post pin)
- POST happy: creates bill, bumps vendor ap_balance by
  amount
- /pay: unknown 404, already-paid 400, partial pay
  (status=partial + ap_balance reduced + ytd_paid
  credited), full pay (status=paid + paid_at stamped)

### Test infra updates

cleanupAllSchema now includes:
- `journal_entries` (lines cascade automatically)
- `books_bills`
- `books_transactions`

All three are RESTRICT-FK to books_accounts (and bills
also to books_vendors), so they must clear before the
parent tables. Added before the existing
books_accounts/employees/contractors/vendors deletes.

## Files touched

```
apps/api/src/routes/
  books.ts                              (MODIFIED — 4 bug
                                         fixes: 3 scope
                                         validations on
                                         journal/tx/bills
                                         + paid_at param
                                         type fix)
  books-journal-tx-bills.test.ts        (NEW — 545 lines,
                                         27 cases)

apps/api/src/test/
  dbHelpers.ts                          (MODIFIED — added
                                         journal_entries +
                                         books_bills +
                                         books_transactions
                                         to cleanup chain)
```

No migrations. No schema changes. No frontend touched.

## Decisions made during build

| Question | Decision |
|---|---|
| Fix the /bills/:id/pay always-500 bug in pass or flag? | **Fix in pass.** Discovered by the first /pay test. Cannot ship a test slice that pins a 500-on-every-call endpoint as the "correct" behavior. The fix is a one-line restructure (compute paid_at in JS) with zero contract change. |
| Resolve the parameter-type ambiguity by adding `::text` cast or by restructuring? | **Restructure.** First-try cast (`$2::text='paid'`) didn't resolve the ambiguity because the column assignment context still demanded varchar. Moving the paid_at clause into JS-interpolated SQL is the smaller-blast-radius fix: only the WHEN/THEN branch changes, the rest of the SQL is identical to pre-fix. |
| Fix the overpayment cap in pass too? | **No — flag for Nic.** The right fix depends on product intent: reject overpay (cleanest), cap at remaining (silently surprising), or accept as advance/credit (most user-friendly but adds product surface). Pre-launch dev environment — not blocking. Nic decides. |
| Test the actual balance-update math on POST /journal (asset +debit, income -debit)? | **Yes — explicit pin.** The route uses `balance = balance + (debit - credit)`, which means asset accounts (debited) gain and income accounts (credited) LOSE in raw balance (sign convention is "balance reflects debit side"). Test pins both directions so a future refactor that flips the sign breaks the test. |
| Use the route or raw INSERTs to seed the void-test entry? | **Use the route.** The void path reads from journal_entry_lines AND from the current account.balance, so seeding via the route ensures the balances are in the expected state to reverse. Raw INSERTs would require duplicating the balance-update logic in the test fixture, which would diverge from the route on any refactor. |

## Verification

- `npx tsc --noEmit` clean on apps/api (0 errors).
- `npm test` in apps/api: **1264 tests across 74 files,
  0 failures**, 692.07s.
- 27 new test cases.
- **4 production bug fixes** (3 cross-tenant scope +
  1 critical always-500 endpoint).
- 0 production regressions.

## Items deferred — what S387 could target

### books.ts arc — 1 slice remaining

S383+S384+S385+S386 covered 34 of 40 books.ts routes
(85%). Slice 5 = reports (~6 routes: pl /
balance-sheet / cash-flow / owner-statements / tax /
rent-roll) closes the arc.

Reports are read-only aggregations. Lower bug-yield
than the write-paths just closed, but worth pinning
the SQL contracts (especially the period-range
arithmetic on p&l and cash-flow).

**Recommend slice 5 (reports) for S387** — closes
books.ts at 100%. ~10-15 tests.

### Cross-tenant scope-bypass pattern audit — STILL
recommended

S385 surfaced 3 bookkeeper-write scope bypasses. S386
surfaced 3 more (journal/transactions/bills accountId/
vendorId). **6 instances of the same pattern in 2
sessions on the same file.** The codebase-wide pattern
audit is the highest-yield single session in the
docket — recommend slotting it **after S387** (books
arc close) and **before** moving to the next route
file (esign/credit/pm).

The grep pattern is now well-defined:
- Routes that take a `<scope>Id` from `req.body`
- Use it in INSERT or UPDATE without an ownership check
- Common scope IDs: landlord_id, tenant_id, unit_id,
  property_id, vendor_id, account_id, pm_company_id

Estimated yield: 5-15 more instances across the
remaining 252 uncovered routes.

### Per directive: fix all bugs before Checkr

books.ts arc: 4 sessions in, ~10 production bugs fixed
(S383: 1 critical bookkeeper-read bypass; S385: 3
bookkeeper-write bypasses; S386: 3 scope-validation +
1 always-500 endpoint = 4). 1 slice to close.

The books.ts arc bug-yield rate has been
extraordinarily high — averaging 2.5 bug fixes per
session vs the tenants.ts arc rate of 1 per ~5 routes.
This suggests the audit's "critical band" classification
(books.ts ranked #1) was correct.

### Pending Nic decisions (accumulated)

Unchanged from S385 close + 1 new from S386:
- (S376) FlexCredit ↔ rent-reporting naming
- (S377) Invite token leakage / column overload / expiry
- (S380) Avatar upload XSS posture
- (S380) PATCH /profile email validation policy
- (S384) POST /contractors required-field rule
- **(S386-new) POST /bills/:id/pay overpayment policy**
  (reject / cap / accept-as-credit / current behavior)
- Consumer-side retention framing (S300)
- FlexCredit Lender partner
- SLA § 9.1.4(iii) deposit-return offset
- Stripe live keys / Resend / Plaid / Stripe Terminal

## Items deferred (cross-session docket, post-S386)

(Unchanged from S385 + the S386 overpayment finding above.)

## Nic-pending

Updated with one new (S386):
- All carried items
- **(S386)** POST /bills/:id/pay overpayment policy

## What S387 should target

**Recommended:** books.ts slice 5 — reports (~6 routes,
~10-15 tests). Closes the books arc at 40/40 routes
(100%).

**Then S388:** cross-tenant scope-bypass pattern audit
(1 session, codebase-wide grep + manual review). 6
instances found in books.ts alone over 2 sessions —
the pattern is reliably present.

After audit: move to next critical-band file. Per
COVERAGE_AUDIT_S382.md, the next highest-yield is
esign.ts (16 uncovered of 25, 36% covered) or
credit.ts (16/16, 0%).

---

End of S386 handoff. **books.ts slice 4 / 10 routes / 27
tests / 4 production bug fixes (3 cross-tenant scope +
1 critical always-500 /bills/:id/pay endpoint).** 1264
tests / 74 files / 0 failures.

books.ts coverage: **34 / 40 (85%)** after 4 slices.
Slice 5 (reports) closes the arc at 100%.

**Pattern signal strengthening:** 6 cross-tenant scope
bugs across S385+S386 in a single file. The codebase-
wide audit will likely surface 5-15 more.
