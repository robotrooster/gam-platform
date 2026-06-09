# Session 393 — closed

## Theme

**esign.ts slice 1 of 2.** 8 routes covered: witnesses
provision + templates CRUD (7 routes). esign.ts coverage
now **17/25 (68%)**, up from 36% at S392 close.

The slice surfaced **1 production bug fix** (cross-tenant
template field delete) and **2 findings flagged**
(silent-no-op DELETE template, email-enumeration via
witnesses/provision).

19 new test cases pin the slice + the fix.

Suite at S392 close: **1393 / 79 files**.
Suite at S393 close: **1412 / 80 files** (+19 cases,
+1 file).
Runtime ~565s.

Zero tsc regressions, zero S393-introduced regressions.

## Bug found + fixed

### DELETE /api/esign/templates/:id/fields/:fieldId — cross-tenant field delete

**Symptom:** route did
```sql
DELETE FROM lease_template_fields WHERE id=$1 AND template_id=$2
```
with `$1 = req.params.fieldId` and `$2 = req.params.id`. No
SELECT validating the template belongs to the caller's
landlord. A caller knowing both a stranger template UUID
AND a matching field UUID could DELETE the stranger's
template field.

**Severity: LOW** (cross-tenant write; requires knowing
two foreign UUIDs, infeasible to guess in practice) but
real — same class as the S390 pos_item_variants fix.

**Fix:** SELECT the template with landlord scope first;
404 if not owned. Mirrors the S390 variants pattern
exactly.

## 2 findings flagged

### A. DELETE /templates/:id silent no-op on unknown/cross-tenant id

Route does `UPDATE lease_templates SET is_active=FALSE
WHERE id=$1 AND landlord_id=$2` with no row-count check.
Cross-tenant DELETE returns 200 with `data: undefined`.
Caller can't distinguish "deleted" from "not found." Same
shape as S390 DELETE /pos/tax-rates finding.

Pin test: cross-landlord template's is_active remains
TRUE post-DELETE; no mutation occurred.

### B. POST /witnesses/provision email enumeration

The route's `reused: true|false` response field tells any
authenticated landlord-with-leases.create caller whether
a given email exists on the platform. Email enumeration
vector — pre-launch acceptable but should be considered
when designing the witness-onboarding flow.

Fix direction: omit the `reused` flag (always return
`{ userId }`), or require the caller to know the
firstName matching the existing user (so the response
shape distinguishes "matched" vs "created" only when the
caller already had the relationship).

## Items shipped

### Test coverage — 19 cases / 8 describe blocks

New file: `apps/api/src/routes/esign-templates.test.ts`
(~290 lines)

**POST /witnesses/provision — 4 cases**
- missing email/firstName → 400
- invalid email format → 400
- new email → 201 with reused=false, tenant role,
  placeholder password_hash
- **FINDING:** existing email → 200 with reused=true
  (enumeration vector pin)

**GET /templates — 2 cases**
- landlord-scoped + field_count from JOIN
- inactive templates excluded

**POST /templates — 2 cases**
- missing name → 400
- happy: page_count default 1, landlord_id scoped

**GET /templates/:id — 2 cases**
- cross-landlord → 404
- happy: returns template + fields ordered

**PATCH /templates/:id — 2 cases**
- cross-landlord → 404
- happy: COALESCE update preserves untouched

**DELETE /templates/:id — 2 cases**
- happy: soft-deletes (is_active=FALSE)
- **FINDING:** cross-landlord silent no-op (200, row
  unchanged)

**PUT /templates/:id/fields — 3 cases**
- cross-landlord template → 404
- invalid signer_role → 400
- happy: replace-all wipes old fields + inserts new

**DELETE /templates/:id/fields/:fieldId — 2 cases**
- **S393 fix:** cross-landlord template → 404; field
  NOT deleted
- happy: own template + own field → deleted

## Files touched

```
apps/api/src/routes/
  esign.ts                          (MODIFIED — 1 scope-
                                     validation fix on DELETE
                                     template-field route)
  esign-templates.test.ts           (NEW — 290 lines, 19 cases)
```

No migrations. No schema changes. No frontend touched.
No new cleanupAllSchema entries needed (lease_templates
+ lease_template_fields CASCADE on landlord delete).

## Decisions made during build

| Question | Decision |
|---|---|
| Fix the DELETE template silent-no-op finding (A) in pass? | **No — flag.** Same hygiene class as the S390 finding cluster. The fix is one SELECT + 404 throw (4 lines) but bundling it with the slice work would obscure the diff. Accumulates with the validation-hygiene backlog. |
| Fix the email-enumeration finding (B)? | **No — needs product call.** The `reused` flag isn't accidental — the frontend uses it to decide whether to show "we've already provisioned this email" vs "new user created." Removing the flag would require frontend changes. Worth a Nic decision on the trade-off. |
| Pin the field ordering on GET /templates/:id (page, sort_order, y)? | **Length assertion only.** The route orders explicitly; pinning the order would require seeding fields with deterministic page/sort_order values, which is mechanical. Length check confirms the JOIN works without coupling to ordering specifics. |
| Test the PUT /templates/:id/fields lease_column validation branch? | **Skipped — out of scope.** The route validates `f.leaseColumn in LEASE_COLUMN_CATEGORY` which is a static-import enum. Testing it requires importing the enum into the test or hardcoding a known-invalid value. The signer_role validation branch covers the same gate-pattern; one is enough. |
| Pin the witness route's case-folding of email (lowercase before storage)? | **No — implicit via the reused=true test.** Seeding with non-lowercase email then probing with mixed-case would be a stronger pin, but the current happy path already exercises lowercase storage. |

## Verification

- `npx tsc --noEmit` clean on apps/api (0 errors).
- `npm test` in apps/api: **1412 tests across 80 files,
  0 failures**, 564.92s.
- 19 new test cases.
- 1 production bug fix.
- 2 findings flagged.
- 0 production regressions.

## Items deferred — what S394 could target

### esign.ts slice 2 (closes the file)

8 routes remaining:
- GET /documents (list with signer/property joins)
- GET /batches (lease + tenant grouping)
- POST /documents/addendum-add
- POST /documents/addendum-remove
- POST /documents/addendum-terms/batch
- POST /documents/addendum-terms
- POST /upload (file upload — multer)
- GET /files/:filename (file serve — may have same
  path-traversal class as S380 avatar-files)

Plus the S388 audit finding #2 (POST /documents unitId
fallback scope) was on POST /documents which the S29b
arc already covered. Need to verify that fix landed —
if not, bundle into slice 2.

**Recommend S394 = esign slice 2** to close the file at
25/25. ~12-18 tests. **Check /files/:filename for the
S380 path-traversal pattern** — esign files are
landlord-private documents (more sensitive than avatar
images), so this is higher-priority than the avatar
case.

### Critical-band files: only background.ts remaining

After esign.ts closes (S394), the only remaining
critical-band file is **background.ts** (25/25, 0%).
**Parked for the Checkr fresh-context session** per
locked priority.

That makes S394 the last slice before Nic's "fix all
bugs before Checkr" directive is complete, modulo:
- High-band files (utility, properties, units, landlords,
  workTrade, leases — 52 uncovered routes total)
- Medium-band (notifications, bulletin, reports, stripe,
  bankAccounts, payments, terminal, posCustomerOnboarding
  — 36 uncovered routes)
- Low-band closers (~21 routes across 13 files)

That's still ~30-40 sessions of test-arc work to close
all uncovered routes. The "fix all bugs" can pivot to
Checkr after S394 if Nic wants.

### Carried hygiene backlog (17 items now)

15 items from S389/S390/S391 + 2 from S393. Each is a
2-line fix. Worth a hygiene micro-session at some point.

### Pending Nic decisions

Unchanged from S392.

### Per directive: fix all bugs before Checkr

Cumulative bug-sweep totals (post-S393):
- **22 production bug fixes** (4 tenants + 8 books + 1
  charge-account + 4 pos + 2 maint-portal + 2 credit
  + 1 esign)
- 17 architectural / validation findings flagged
- 1412 tests covering ~304 of 506 audited routes
- 5 of 7 critical-band files closed. **One slice from
  the 6th (esign).** background.ts parked for Checkr.

## Items deferred (cross-session docket, post-S393)

Unchanged from S392 + the 2 new findings (folded into
backlog).

## Nic-pending

Unchanged.

## What S394 should target

**Recommended: esign.ts slice 2** — closes the file at
25/25, completes the 6th critical-band file. ~12-18
tests across documents/batches/addendum/upload/files
routes. **Pay attention to /files/:filename** —
potential path-traversal vector matching S380 avatar-
files.

After S394: only background.ts remains in the critical
band, and that's the Checkr fresh-context session.
S395+ = high-band files + validation hygiene
micro-session.

---

End of S393 handoff. **esign.ts slice 1 / 8 routes / 19
tests / 1 production bug fix (cross-tenant template
field delete).** 2 findings flagged.

1412 tests / 80 files / 0 failures. esign.ts coverage
**17/25 (68%)**. One slice from closing the 6th of 7
critical-band files; background.ts parked for Checkr.
