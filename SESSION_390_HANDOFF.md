# Session 390 — closed

## Theme

**pos.ts slice 2** — transactions list + sales
aggregations + purchase-orders GET + variants + tax-rates
+ discounts (13 routes). Closes pos.ts at 55/55 routes
(100%).

The slice surfaced **3 production bug fixes** + **4
findings flagged** (validation gaps and silent-no-op
PATCH).

25 new test cases pin the slice + the fixes.

Suite at S389 close: **1306 / 76 files**.
Suite at S390 close: **1331 / 77 files** (+25 cases,
+1 file).
Runtime ~538s.

Zero tsc regressions, zero S390-introduced regressions.

## Bugs found + fixed

### Bug 1 (MED) — GET /api/pos/items/:id/variants cross-tenant read

**Symptom:** route filtered only by `item_id` with no
landlord scope. Variants table has no landlord_id column
(transitive via item_id); pre-fix a caller knowing a
foreign item UUID could read that item's variant list.

**Fix:** SELECT the item with landlord scope first; 404
if not owned by caller.

### Bug 2 (MED) — PATCH /items/:id/variants/:variantId cross-tenant write

**Symptom:** the SELECT validated (variantId, itemId)
match correctly, but the itemId itself wasn't checked for
ownership. A caller knowing both a foreign item UUID AND
the matching variant UUID could UPDATE that variant.

**Severity:** LOW-MED — needs 2 foreign UUIDs (infeasible
to guess), but is a real cross-tenant write.

**Fix:** SELECT the item with landlord scope first; 404
if not owned.

### Bug 3 (CRITICAL) — GET /transactions/sales always returned 500

**Symptom:** `dateFilter` SQL fragment used unqualified
`created_at` (`AND DATE(created_at) = CURRENT_DATE`),
but the `topItems` and `byCategory` queries JOIN
`pos_transaction_items` (which ALSO has a `created_at`
column). Postgres threw "column reference 'created_at'
is ambiguous" — the route 500'd on every call regardless
of period or data state.

**Severity: CRITICAL.** The sales analytics endpoint
has been completely non-functional in production. Same
class as the S386 `/bills/:id/pay` always-500 bug —
endpoint sat broken because no test covered it.

**Fix:** qualified `created_at` with `t.` alias on the
shared `pos_transactions` table; added `t` alias to the
single-table queries too so the filter compiles in
either context.

## 4 new findings (LOW-severity, flagged)

### A. POST /tax-rates no required-field validation
`name`, `rate`, `taxType` are NOT NULL but route accepts
`{}`. NOT NULL surfaces as 500. Same shape as S389 vendor
finding. Pin: `expect([400,500]).toContain(res.status)`.

### B. POST /discounts no required-field validation
Same shape — `name`, `type`, `value` NOT NULL,
unvalidated.

### C. PATCH /discounts/:id silent no-op on cross-tenant id
Route does direct UPDATE with `WHERE id=$N AND
landlord_id=$M` — no SELECT-then-check. Cross-tenant
id returns 200 with `data: undefined`. Same class as
S384 vendors PATCH finding. Cross-tenant write impact:
zero (row not modified, confirmed by pin).

### D. DELETE /tax-rates/:id silent on unknown/cross-tenant
Soft-deletes with no row-count check. Caller can't
distinguish "deleted" from "not found." Cosmetic.

## Items shipped

### Test coverage — 25 cases / 11 describe blocks

New file: `apps/api/src/routes/pos-tx-variants-tax-discounts.test.ts`
(488 lines)

**GET /transactions — 2 cases**
- Landlord-scoped (cross-tenant excluded)
- item_count joined from pos_transaction_items

**GET /transactions/sales — 2 cases**
- **Empty + S390 fix**: empty response shape (was 500
  on every call)
- **Happy + S390 fix**: aggregates 3 mixed-payment-method
  transactions; summary totals + cash/card/charge
  breakdown

**GET /purchase-orders — 1 case**
- Landlord-scoped; vendor_name joined; item_count
  populated; items array attached per PO

**Variants — 6 cases**
- **GET S390 fix:** stranger item UUID → 404 (was:
  variants returned)
- GET happy: active-only, sort order honored
- POST cross-landlord item → 404
- POST happy: creates variant + flips has_variants=TRUE
- **PATCH S390 fix:** foreign-itemId/variantId combo →
  404; row unchanged (was: updated stranger row)
- PATCH happy: updates own variant

**Tax-rates — 7 cases**
- GET landlord-scoped
- GET ?propertyId= returns property + landlord-wide
  (NULL property_id)
- POST cross-landlord propertyId → 400
- POST happy with default `appliesTo: ['all']`
- **FINDING:** empty body → 500/400 pin
- PATCH unknown → 404
- PATCH cross-landlord → 404
- PATCH happy COALESCE
- DELETE soft-delete

**Discounts — 4 cases**
- GET landlord-scoped active-only
- POST happy
- **FINDING:** empty body → 500/400 pin
- **FINDING:** PATCH cross-landlord silent no-op; row
  unchanged pin
- PATCH happy COALESCE

## Files touched

```
apps/api/src/routes/
  pos.ts                                     (MODIFIED — 3 bug
                                              fixes: variants GET
                                              + variants PATCH +
                                              /transactions/sales
                                              dateFilter ambiguity)
  pos-tx-variants-tax-discounts.test.ts      (NEW — 488 lines,
                                              25 cases)

apps/api/src/test/
  dbHelpers.ts                               (MODIFIED — added
                                              pos_discounts +
                                              pos_item_variants to
                                              cleanupAllSchema)
```

No migrations. No schema changes. No frontend touched.

## Decisions made during build

| Question | Decision |
|---|---|
| Fix the variants cross-tenant bugs in pass or flag? | **Fix in pass.** Both are cross-tenant scope-bypass class (same family as books arc) and the fix pattern is shared (one SELECT validating item ownership). 4-6 lines per route. The pin tests demonstrate the fix works. |
| Fix the /transactions/sales 500 in pass? | **Fix in pass.** It's a CRITICAL always-500 endpoint discovered by the empty-state test. Same precedent as S386's /bills/:id/pay fix — can't ship a slice that pins broken-with-no-fix. |
| Fix the 4 LOW findings (validation gaps) in pass too? | **No — flag.** Same pattern as S389 backlog — they're 2-line fixes each but the bundling cost > the fix cost. Let the validation-hygiene micro-session sweep all of them together later. |
| Resolve the dateFilter ambiguity by qualifying with `t.` or by inlining the filter into each query? | **Qualify with `t.` alias.** Three of four queries already used `pos_transactions` as the primary table; adding the `t` alias was minimally invasive. The shared dateFilter fragment is preserved (just qualified), so future query additions get the right qualification automatically. |
| Test ?period=week and ?period=month branches on /transactions/sales? | **No — today-period covers the SQL path.** The dateFilter expression varies per period but all three feed into the same query shape. Today is the most common and the previously-broken default; testing the variants would be ceremony. |
| Pin the variants fix with explicit "was-broken" comments in the test? | **Yes — `S390 fix:` prefix on the two test names.** Documents the fix in the test file itself; future readers see the bug context without grepping the handoff. |

## Verification

- `npx tsc --noEmit` clean on apps/api (0 errors).
- `npm test` in apps/api: **1331 tests across 77 files,
  0 failures**, 537.83s.
- 25 new test cases.
- **3 production bug fixes** (2 variants cross-tenant +
  1 always-500 sales aggregation).
- 4 new findings flagged.
- 0 production regressions.

## pos.ts arc summary (S347 + S389 + S390)

| Slice | Session | Routes | Tests | Bugs fixed |
|---|---|---:|---:|---:|
| Items/categories/PO core | S347 | ~16 | n/a | 0 |
| Transactions / refund / void / eod | S338-S343 | ~16 | n/a | 0 |
| Inventory + vendors + categories | S389 | 10 | 26 | 1 (vendorId scope bypass) |
| Tx-list + sales + variants + tax + discounts | S390 | 13 | 25 | 3 (2 variants cross-tenant + 1 always-500) |
| **Cumulative** | **S338-S390** | **55 / 55 (100%)** | — | **4 production fixes in 2 sessions** |

pos.ts coverage is now **100%**. The cross-tenant
scope-bypass pattern surfaced 3 more instances (after
the 6 in books.ts) — pattern count is now 9
cross-tenant fixes across 2 files.

## Items deferred — what S391 could target

### Critical-band files remaining per COVERAGE_AUDIT_S382.md

After pos.ts close:
- **maintenance-portal.ts** — 17/17 uncovered (0%).
  Bundles S388 finding #1 (POST /scheduled scope
  validation). ~17 routes; could be a single big slice or
  split into 2.
- **esign.ts** — 16/25 uncovered (36%). Bundles S388
  finding #2 (POST /documents unitId fallback). Envelope/
  signer/template flows.
- **credit.ts** — 16/16 uncovered (0%). Credit-ledger
  route layer.

**Recommend S391 = maintenance-portal.ts** — small route
file (only 248 lines vs esign's 2533 and credit's 840),
fully uncovered, bundles a known S388 fix. Single
slice could close it.

### Quick-fix backlog (accumulating)

8 small fixes available for a single hygiene micro-session:

From S388 audit:
- maintenance-portal.ts POST /scheduled scope validation
  (will be folded into the slice if S391 = maint-portal)
- esign.ts POST /documents unitId fallback scope
  validation
- pos.ts shelf-label comment update (NO code change)

From S389:
- POST /pos/vendors required-field check
- POST /pos/items/:id/adjust-stock reason enum
  validation

From S390:
- POST /pos/tax-rates required-field check
- POST /pos/discounts required-field check
- PATCH /pos/discounts/:id add SELECT-then-404 check
- DELETE /pos/tax-rates/:id same

~40 lines total across ~7 files. One hygiene session
would clean them all.

### Pending Nic decisions (carried)

Unchanged from S389.

### Per directive: fix all bugs before Checkr

Cumulative bug-sweep totals (post-S390):
- **17 production bug fixes** (4 cross-tenant tenants
  arc + 8 books arc + 1 charge-account + 4 pos arc)
- 10 architectural / validation findings flagged
- 1331 tests covering ~250 of 506 audited routes;
  ~25-35 sessions to close the remaining uncovered
  routes at current pace

## Items deferred (cross-session docket, post-S390)

Unchanged from S389 + the 4 new findings (folded into
quick-fix backlog).

## Nic-pending

Unchanged.

## What S391 should target

**Recommended:** **maintenance-portal.ts full slice** —
17 routes, 0% coverage, bundles S388 audit finding #1
fix. ~20-25 tests. Closes the file at 100% in one
session.

**Alternative:** the 8-item validation-hygiene
micro-session (~40 lines total, ~10-15 tests to pin
each fix). Cleans the accumulating backlog before more
findings pile on.

---

End of S390 handoff. **pos.ts slice 2 / 13 routes / 25
tests / 3 production bug fixes (2 variants cross-tenant
+ 1 CRITICAL always-500 sales aggregation).** 4 new
findings flagged.

**pos.ts arc CLOSED at 55/55 routes (100%).** 1331
tests / 77 files / 0 failures.
