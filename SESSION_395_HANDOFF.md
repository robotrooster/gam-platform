# Session 395 — closed

## Theme

**landlords.ts gap-close slice — CLOSES the file at
55/55 (100%).** 8 routes covered: admin landlords list,
flex-charge accounts list + statements, theme read, and
the 4-route pending-tenants intent flow (upload, GET
document, GET intent, resolve).

The slice surfaced **1 CRITICAL production bug fix**:
the GET /me/pending-tenants/:intentId/document route
was completely broken — always returned 404 due to a
column-content mismatch between POST (stored API URL)
and GET (extracted filename from URL → got literal
`'document'`). Discovered during the slice's first
happy-path test.

Plus one architectural note (third instance of the
XSS extension-mismatch pattern, defended at read-path).

20 new test cases pin the slice + the fix.

Suite at S394 close: **1430 / 81 files**.
Suite at S395 close: **1450 / 82 files** (+20 cases,
+1 file).
Runtime ~850s.

Zero tsc regressions, zero S395-introduced regressions.

## Bug found + fixed — CRITICAL

### GET /me/pending-tenants/:intentId/document always returned 404

**Symptom:** the POST route at line 1457 stored
`imported_pdf_url = '/api/landlords/me/pending-tenants/' + intentId + '/document'`
(the API endpoint URL) into the
`pending_tenant_intents.imported_pdf_url` column. The
GET route at line 1533 read that column and called
`extractUploadFilename(intent.imported_pdf_url)` — but
the helper does `path.basename` which on a URL like
`/api/landlords/me/pending-tenants/<id>/document`
returns the literal string `'document'`. The route
then tried to serve `uploads/lease-pdfs-pending/document`
— a file that never exists → 404 on every call.

**Severity: CRITICAL.** The entire pending-tenants
parser-import flow's "review the uploaded PDF" step has
been completely non-functional. Landlord uploads a lease
PDF, parser extracts fields, frontend tries to display
the PDF for confirmation → 404. The flow is unusable in
production.

Same precedent class as:
- **S386 /bills/:id/pay** (parameter type ambiguity →
  always 500)
- **S390 /transactions/sales** (ambiguous column →
  always 500)
- **S394 esign upload XSS** (extension mismatch)

**Fix:** store the actual multer-generated filename
(`req.file.filename`, e.g. `1234567890-abc.pdf`) in
`imported_pdf_url` instead of the API endpoint URL. The
response still surfaces `fileUrl` to the frontend (the
API endpoint, constructed from intentId) for use in
`<iframe>`/`<a href>` rendering. The DB column now
carries the on-disk filename so the GET can resolve.

Bug discovered by writing the slice's first happy-path
test for the GET route, which 404'd until the fix
landed.

## Architectural note (NOT a new bug, but third instance)

### Third XSS extension-mismatch instance — defended at read-path here

POST /me/pending-tenants/:intentId/document uses the
same multer pattern as S380 avatar + S394 esign:
- MIME filter: application/pdf only ✓
- Saved filename: `Date.now() + extname(originalname)`
  UNFILTERED ✗

But the GET route at line 1556 sets
`Content-Type: application/pdf` explicitly via
`res.setHeader` BEFORE `res.sendFile`. Express's
sendFile respects existing Content-Type, so the served
file always lands as `application/pdf` regardless of
on-disk extension. **The XSS doesn't surface through
this route's read path.**

That said: defense-in-depth would suggest fixing the
write-path too (force `.pdf` extension). Bundle into
the validation-hygiene micro-session along with:
- S380 avatar-files write-path (still open)
- (S394 esign upload write-path was fixed in S394)

## Items shipped

### Test coverage — 20 cases / 9 describe blocks

New file: `apps/api/src/routes/landlords-gap-close.test.ts`
(~440 lines)

**GET / (admin) — 2 cases**
- Non-admin → 403
- Admin: returns landlords + property/unit counts +
  bank_account_ready

**GET /flex-charge/accounts — 2 cases**
- Empty list when no accounts
- Returns own-landlord accounts only (cross-tenant
  isolation verified)

**GET /flex-charge/accounts/:id/statements — 2 cases**
- Unknown id → non-200 (service errors)
- Cross-landlord account → non-200 (service rejects)

**GET /theme — 2 cases**
- Returns theme/font fields (defaults null)
- PATCH /theme then GET reflects the change

**POST /me/pending-tenants/:intentId/document — 4 cases**
- No file → 400
- Unknown intent → 404 + uploaded file cleaned up
- intent in 'parsing' status → 409 (state guard)
- Happy: stores PDF, flips status to 'parsing', schedules
  parser job

**GET /me/pending-tenants/:intentId/document — 2 cases**
- No PDF on intent → 404
- **S395 fix:** happy path streams PDF back with
  explicit `Content-Type: application/pdf` (was: 404
  always pre-fix)

**GET /me/pending-tenants/:intentId — 3 cases**
- Unknown → 404
- Cross-landlord intent → 404
- Happy: returns intent details + tenant user info +
  parser_output JSONB

**POST /me/pending-tenants/:intentId/resolve — 2 cases**
- Array landlordOverrides → 400 (non-object guard)
- Happy: calls resolveIntent with overrides + returns
  result
- Empty body: resolveIntent called with `{}` (null
  also flows here via `?? {}`)

## Files touched

```
apps/api/src/routes/
  landlords.ts                          (MODIFIED — 1
                                         CRITICAL fix:
                                         store filename
                                         not URL in
                                         imported_pdf_url)
  landlords-gap-close.test.ts           (NEW — 440 lines,
                                         20 cases)
```

No migrations. No schema changes. No frontend touched.

## Decisions made during build

| Question | Decision |
|---|---|
| Fix the pending-tenants GET document 404 in pass? | **Yes — CRITICAL.** Discovered during the first happy-path test. The route is completely non-functional in production; pinning the broken state as "correct" would be wrong. The fix is one line (`req.file.filename` instead of `fileUrl` in the column update). |
| Fix the third XSS extension-mismatch instance (POST /me/pending-tenants/document) in pass? | **No — flag.** Read-path already defends via explicit `setHeader('Content-Type', 'application/pdf')` before sendFile. The XSS doesn't surface in production. Defense-in-depth fix belongs in the validation-hygiene micro-session along with the still-open S380 avatar instance. |
| Mock `scheduleParserJob` + `resolveIntent`? | **Yes — vi.mock + vi.hoisted.** The parser job spawns async work via setTimeout / external IO; calling it for real in tests would create flaky timing dependencies. The slice's contract is "the route stores correctly + calls the right service" — service behavior is tested separately. |
| Test the cross-landlord case on GET /me/pending-tenants/:intentId? | **Yes.** The route's WHERE filters by `landlord_id = $2`; the test confirms a different landlord's token gets 404. This is the analog of the books arc cross-tenant tests — pinning the predicate is cheap insurance. |
| Test the actual schedule parser-job invocation? | **`expect(scheduleParserJobMock).toHaveBeenCalledWith(id)`** — confirms the route invokes it with the right intent id. Doesn't exercise the job itself. |

## Verification

- `npx tsc --noEmit` clean on apps/api (0 errors).
- `npm test` in apps/api: **1450 tests across 82 files,
  0 failures**, 850.22s.
- 20 new test cases.
- 1 CRITICAL production bug fix.
- 1 architectural note (third XSS instance, defended at
  read-path).
- 0 production regressions.

## Items deferred — what S396 could target

### Critical-band cleanup complete

After S395, the critical-band sweep is done EXCEPT for
background.ts (parked for Checkr fresh-context).
landlords.ts at 100% closes the 7th critical/high-traffic
file.

### Remaining files per COVERAGE_AUDIT_S382.md

**High band (52 uncovered total):**
- utility.ts — 12/12 uncovered (0%)
- properties.ts — 9/17 uncovered (47%)
- units.ts — 9/17 uncovered (47%)
- workTrade.ts — 8/8 uncovered (0%)
- leases.ts — 6/15 uncovered (60%)

**Medium band (36 uncovered total):**
- notifications.ts — 6/6 (0%) [BUT see audit: low-traffic
  + service-validated]
- bulletin.ts — 5/5 (0%)
- reports.ts — 5/5 (0%)
- stripe.ts — 5/5 (0%)
- bankAccounts.ts — 4/4 (0%)
- payments.ts — 4/4 (0%)
- terminal.ts — 4/4 (0%)
- posCustomerOnboarding.ts — 3/3 (0%)

**Low band (21 uncovered across 13 files):**
- Small gap-closes — could batch 2-3 files per session.

**Recommend S396 = `workTrade.ts` full slice** — 8/8
uncovered, 332 lines, small file, single session. OR
**utility.ts** (12/12, 388 lines, also a single
session) since utility billing is money-handling and
likely high-yield.

### Validation-hygiene backlog (now ~18 items)

Same as S394 + the pending-tenants write-path defense-
in-depth fix from S395. Worth running before the
mid-traffic files (utility, properties, units, leases)
pile on more findings.

### Pending Nic decisions

Unchanged.

### Per directive: fix all bugs before Checkr

Cumulative bug-sweep totals (post-S395):
- **24 production bug fixes** (4 tenants + 8 books +
  1 charge-account + 4 pos + 2 maint-portal + 2 credit
  + 2 esign + 1 landlords)
- 18 architectural / validation findings flagged
- 1450 tests covering ~320 of 506 audited routes (63%)
- **All 7 critical-band files closed except
  background.ts** (Checkr).

## Items deferred (cross-session docket, post-S395)

Unchanged from S394 + the pending-tenants write-path
defense-in-depth flag.

## Nic-pending

Unchanged.

## What S396 should target

**Recommended: utility.ts full slice** (12 routes, 388
lines, 0% coverage). Utility billing = money-handling →
historically high-yield surface in the sweep.

**Alternative paths:**
- `workTrade.ts` full slice (8 routes, simpler)
- Validation-hygiene micro-session to clear the 18-item
  backlog (smaller diff)
- Checkr API wire-up (pivot now per locked priority —
  the critical band is functionally cleared)

---

End of S395 handoff. **landlords.ts arc CLOSED at 55/55
routes (100%).** Slice / 20 tests / 1 CRITICAL
production bug fix (pending-tenants GET document was
always 404 due to URL-vs-filename column confusion).

1450 tests / 82 files / 0 failures. All 7 critical-band
files closed (modulo background.ts/Checkr).
