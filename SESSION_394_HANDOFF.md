# Session 394 — closed

## Theme

**esign.ts slice 2 of 2 — CLOSES the file at 25/25 (100%).**
8 routes covered: documents list, batches, addendum-add/
remove/terms/terms-batch, upload, files.

The slice surfaced **1 production bug fix** (upload
extension-mismatch XSS — same class as S380 avatar) and
**1 architectural hygiene note** (S380 avatar-files
should adopt the `resolveUploadPath` helper used here for
belt+suspenders).

18 new test cases pin the slice + the fix.

Suite at S393 close: **1412 / 80 files**.
Suite at S394 close: **1430 / 81 files** (+18 cases,
+1 file).
Runtime ~701s.

Zero tsc regressions, zero S394-introduced regressions.

## Bug found + fixed

### POST /api/esign/upload — XSS via extension mismatch

**Symptom:** multer's `filename` callback used
`path.extname(file.originalname)` UNFILTERED. The MIME
filter accepts only `application/pdf` (good), but the
saved filename's extension came from the attacker-
controlled `originalname`. An upload with
`Content-Type: application/pdf` + `originalname: evil.html`
+ HTML payload bytes would be saved as
`1234567890-abc.html`.

GET /api/esign/files/:filename serves via `res.sendFile`
which auto-detects Content-Type from the on-disk
extension → `text/html` → **XSS in the authorized
viewer's browser context** (a landlord opening their own
doc, or a signer following the signing link).

**Severity:** LOW-MED — requires the attacker to be an
authenticated landlord with `leases.create`, but if
exploited, the malicious doc would execute in the
signer's browser when they preview/sign. Same class as
the **still-open** S380 avatar-files finding.

**Fix:** force `.pdf` extension regardless of
originalname:
```js
filename: (req, file, cb) => {
  const unique = Date.now() + '-' + Math.random().toString(36).slice(2)
  cb(null, unique + '.pdf')  // was: path.extname(file.originalname)
}
```
One-line change. The `application/pdf` MIME filter
already rejects non-PDF uploads, so the saved extension
matching the MIME is correct + deterministic.

Pinned by: "S394 fix: PDF upload with originalname=evil.html
→ saved as .pdf (not .html)" — pre-fix would have produced
`.html`; post-fix asserts `.pdf$` and `!.html`.

## Architectural note (hygiene flag, NOT fixed in S394)

### S380 avatar-files should adopt resolveUploadPath

GET /api/esign/files/:filename uses the
`resolveUploadPath` helper from `lib/uploadPaths.ts` which
provides **3-layer defense**:
1. `path.basename` strips directory components
2. `[A-Za-z0-9_.-]+` regex allowlist on the basename
3. `path.relative` confirms the resolved path didn't
   escape the upload dir

The S380 avatar-files fix used `path.basename` only —
layer 1 only. Should adopt the same helper for
consistency and belt+suspenders defense. Not a bug
today (path.basename alone blocks the obvious traversal)
but lower defense-in-depth than the esign route.

One-line refactor — bundle into the validation-hygiene
micro-session.

## Items shipped

### Test coverage — 18 cases / 7 describe blocks

New file: `apps/api/src/routes/esign-documents-files.test.ts`
(~390 lines)

**GET /documents — 1 case**
- Landlord-scoped with signer_count + signed_count joins;
  property_name from JOIN

**GET /batches — 2 cases**
- Empty: 0 batches → []
- Landlord-scoped: returns batch with completed_count,
  pending_count, voided_count (3 docs across statuses)

**POST /documents/addendum-add — 3 cases (gates)**
- Missing leaseId → 400
- Unknown lease → 404
- Cross-landlord lease → 403

**POST /documents/addendum-remove — 2 cases (gates)**
- Missing leaseId → 400
- Cross-landlord lease → 403

**POST /documents/addendum-terms — 1 case**
- Missing leaseId → 400

**POST /documents/addendum-terms/batch — 1 case**
- Missing required fields → 400

**POST /upload — 4 cases**
- No file → 400
- Non-PDF MIME → rejected by fileFilter
- **S394 fix:** PDF + originalname=evil.html → saved as
  .pdf, never .html (pre/post assert on disk)
- Happy: legitimate PDF upload returns url/filename/size

**GET /files/:filename — 4 cases**
- Invalid filename (traversal) → not 200 (helper or 404
  rejects)
- Unknown filename → 404
- Landlord on the document → 200 with PDF bytes
- Cross-landlord (no signer relationship) → not 200

## Files touched

```
apps/api/src/routes/
  esign.ts                              (MODIFIED — 1 fix:
                                         force .pdf
                                         extension in upload
                                         filename callback)
  esign-documents-files.test.ts         (NEW — 390 lines,
                                         18 cases)
```

No migrations. No schema changes. No frontend touched.
No new cleanupAllSchema entries (lease_documents +
document_batches + lease_document_signers all CASCADE
on landlord/template delete).

## Decisions made during build

| Question | Decision |
|---|---|
| Fix the upload extension-mismatch in pass? | **Yes.** One-line change, same class as the still-open S380 avatar finding (which I'd flagged but not fixed). Fixing here closes the higher-value (lease documents > avatar images) instance and validates the fix pattern; the avatar fix can follow as a hygiene micro-fix. |
| Cover the full happy path on addendum-add / addendum-remove? | **No — gate cases only.** The addendum routes have 5-7 dependent steps each (lease lookup, current roster, signer validation, tenant profile resolution, transaction). Full happy-path tests would require seeding a complex multi-signer lease scenario with 50+ lines of fixture setup each — diminishing returns vs the gate-pattern tests this slice already pins. The S29b arc covers the happy paths in the e-sign signing flow. |
| Pin the file bytes on GET /files (round-trip the upload)? | **Yes — PDF header check.** Upload PDF, attach to lease_documents.base_pdf_url, GET back, assert response body starts with `%PDF`. Proves both the upload and the serving paths end-to-end. |
| Test the path-traversal via URL-encoded `..` in the route param? | **Yes — assert non-200.** The resolveUploadPath helper's regex allowlist + `path.relative` escape check should reject; the slice asserts the response is not 200 (could be 400, 404, or even a router-level 404 from Express's :param handling). The defense itself doesn't matter as long as the traversal is blocked. |
| Cover the addendum-add full multi-signer happy path? | **No — out of scope.** Would require a 100-line fixture (lease + 2 active tenants + new tenant signer). Worth a dedicated future slice if Nic wants the addendum-add path specifically locked down with happy-path coverage. |

## Verification

- `npx tsc --noEmit` clean on apps/api (0 errors).
- `npm test` in apps/api: **1430 tests across 81 files,
  0 failures**, 700.55s.
- 18 new test cases.
- 1 production bug fix (esign upload XSS).
- 0 production regressions.

## esign.ts arc summary (S29b + S393 + S394)

| Slice | Session | Routes | Tests | Bugs fixed |
|---|---|---:|---:|---:|
| Core signing flow | S29b | ~9 | n/a | (S29b context) |
| Witnesses + Templates CRUD | S393 | 8 | 19 | 1 (template-field cross-tenant) |
| Documents + batches + addendum + upload + files | S394 | 8 | 18 | 1 (upload XSS extension-mismatch) |
| **Cumulative** | **S29b-S394** | **25 / 25 (100%)** | — | **2 in 2 sessions** |

## 6 of 7 critical-band files now closed

Per COVERAGE_AUDIT_S382.md:
- ✅ tenants.ts (40/40, S374-S381)
- ✅ books.ts (40/40, S383-S387)
- ✅ pos.ts (55/55, S347 + S389-S390)
- ✅ maintenance-portal.ts (17/17, S391)
- ✅ credit.ts (16/16, S392)
- ✅ esign.ts (25/25, S29b + S393-S394) ← S394
- ❌ background.ts (0/25) — **PARKED for Checkr fresh-context session**

The only remaining critical-band file is the one Nic
explicitly parked. Per the directive "fix all bugs
before Checkr," the test-arc remaining is:
- High-band files (~52 uncovered routes)
- Medium-band (~36 uncovered)
- Low-band closers (~21 uncovered)
- Validation-hygiene micro-session (~17 items)

That's ~30-40 sessions of remaining work to close
EVERY route. Or Nic can pivot to Checkr now and pick up
the rest later.

## Items deferred — what S395 could target

### Three viable paths

**Path A (continuing the bug sweep):** highest-yield
high-band file. Per audit:
- `utility.ts` — 12/12 uncovered, 388 lines (smaller)
- `properties.ts` — 9/17 uncovered, 1031 lines
- `units.ts` — 9/17 uncovered, 540 lines
- `landlords.ts` — 8/55 uncovered (85% covered, just
  close the gap)
- `workTrade.ts` — 8/8 uncovered, 332 lines
- `leases.ts` — 6/15 uncovered (60%, gap-close)

**Recommend `landlords.ts` gap-close** — only 8 routes
left to close a high-coverage file. Quick win + one
fewer file to track.

**Path B (validation-hygiene micro-session):** clean the
17-item backlog from S388/S389/S390/S391/S393. ~40 lines
of changes + ~20 small test pins. Closes the accumulated
findings before more pile on.

**Path C (Checkr API wire-up):** pivot to background.ts
per locked priority. Per memory note `project_checkr_access_unblocked.md`
this is the planned fresh-context session.

Recommend **A or B** before C — neither is a Nic-pending
blocker.

### Pending Nic decisions (carried)

Unchanged from S393.

### Per directive: fix all bugs before Checkr

Cumulative bug-sweep totals (post-S394):
- **23 production bug fixes** (4 tenants + 8 books + 1
  charge-account + 4 pos + 2 maint-portal + 2 credit
  + 2 esign)
- 18 architectural / validation findings flagged
- 1430 tests covering ~312 of 506 audited routes (62%)
- **6 of 7 critical-band files closed.** Only
  background.ts remains and that's the Checkr session.

## Items deferred (cross-session docket, post-S394)

Unchanged from S393 + 1 new architectural note (avatar-
files adopt resolveUploadPath).

## Nic-pending

Unchanged.

## What S395 should target

**Recommended: landlords.ts gap-close slice.** 8
uncovered routes of 55 (already 85% covered). Quick
closer for one of the highest-traffic route files in
the codebase. Then pick the next file based on yield.

Alternative: validation-hygiene micro-session to clear
the 17-item backlog (smaller diff, but accumulates
findings) — worth doing soon either way.

---

End of S394 handoff. **esign.ts arc CLOSED at 25/25
routes (100%).** Slice 2 / 8 routes / 18 tests / 1
production bug fix (upload XSS extension-mismatch,
same class as S380 avatar).

1430 tests / 81 files / 0 failures. **6 of 7
critical-band files closed.** background.ts is the
locked Checkr fresh-context session — only remaining
critical-band file.
