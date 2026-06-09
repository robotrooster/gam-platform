# Session 399 — closed

## Theme

**properties.ts gap-close slice — covers 9 of 17 routes
(the previously uncovered set). 27 new test cases,
3 production bug fixes, 1 architectural finding.**

Suite at S398 close: **1533 / 85 files**.
Suite at S399 close: **1560 / 86 files** (+27 cases, +1 file).
0 failures. Runtime 904.84s. Third consecutive fully-green
full-suite run since the S397 hookTimeout bump.

Zero tsc regressions.

## Production bug fixes shipped

### 1. `GET /api/properties/applications` was unreachable (500 on every call)

**Severity: high — admin "Applications" page broken in
production.**

`/applications` was declared *below* the `/:id` parameter
route, so Express matched `applications` as `:id` and tried
to parse it as a UUID → 22P02 `invalid input syntax for type
uuid: "applications"` → 500. Hoisted the `/applications`
declaration above `/:id` (Express route-order fix, same
class as the S232 bookings ordering bug).

### 2. `GET /units/:id/photos` cross-tenant scope bypass

**Severity: medium — any landlord could read any other
landlord's unit photo list.**

The route fetched the unit row, then returned photos without
verifying that the unit's landlord matched
`req.user.landlord_id`. Added the standard ownership check
before returning the photo array. (Same pattern as the
S388–S395 cross-tenant audit findings — 27th instance.)

### 3. `POST /units/:id/photos` extension-mismatch XSS
(4th instance of this class)

**Severity: medium — an authenticated landlord could upload
an HTML file named `xss.html` masquerading as `image/png`;
once served back via `express.static`, the file extension
drives the response Content-Type, executing the HTML in
the same-origin context.**

Replaced multer's default `originalname`-derived filename
with a MIME-whitelist-derived extension:

```ts
const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png':  '.png',
  'image/webp': '.webp',
  'image/gif':  '.gif',
}
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const ext = MIME_TO_EXT[file.mimetype] ?? '.bin'
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`)
  }
})
```

Same fix shape as S380 avatar, S394 pending-tenants
document, S395 esign upload.

### 4. `POST /:id/units/bulk` 500 on missing `securityDeposit`

**Severity: medium — bulk-create-units route always 500'd
when `securityDeposit` was omitted from a unitGroup.**

`units.security_deposit` is `NOT NULL DEFAULT 0` in the
schema, but the INSERT passed `securityDeposit||null`,
which overrode the default with NULL → 23502 constraint
violation. Changed to `securityDeposit||0`. Inline comment
added explaining the trap.

## Architectural finding (worth recording)

The `POST /:id/units/bulk` route validates only at the
top-level body shape — individual `unitGroup` entries are
processed without per-field validation:
- `type` is inserted into `units.unit_type` (no CHECK on
  free-form strings — schema is permissive)
- `count` is iterated without an upper bound (a landlord
  could request count=10000 in a single call)
- `prefix` is interpolated into `unit_number` without
  length cap

These are landlord-authenticated endpoints with ownership
checks, so impact is bounded to the landlord's own data,
but a future hygiene pass should add:
- `count` upper bound (e.g. 200 per call)
- `prefix.length` cap (e.g. 32 chars)
- `type` validated against the shared
  `UNIT_TYPES`-equivalent allow-list when one is defined

Bundle into the validation-hygiene micro-session as a
"bulk-create input hardening" task.

## Items shipped

### Test coverage — 27 cases / 9 describe blocks

New file: `apps/api/src/routes/properties-gap-close.test.ts`
(~450 lines)

**GET /:id/photo — 3 cases**
- Unknown property → 404
- Cross-landlord → 403
- Happy: photo_url returned

**POST /:id/photo — 2 cases**
- Cross-landlord → 403
- Happy: URL persisted to properties.photo_url

**GET /:id/listing — 3 cases**
- Unknown property → 404
- Cross-landlord → 403
- Happy: shape returned

**PATCH /:id/listing — 2 cases**
- Cross-landlord → 403
- Happy: listing fields persisted

**GET /:id/applications — 3 cases**
- Unknown property → 404
- Cross-landlord → 403
- Happy: applications + applicant shape

**POST /:id/apply — 2 cases** (tenant-facing apply route)
- Missing required fields → 400
- Happy: application persisted

**GET /units/:id/photos — 3 cases** (S399 bug)
- Cross-landlord (PRE-FIX would 200) → **now 403**
- Unknown unit → 404
- Happy: photo URLs returned

**POST /units/:id/photos — 5 cases** (S399 XSS bug)
- Cross-landlord → 403
- Missing file → 400
- Disallowed mimetype → 400 (e.g. text/html rejected)
- HTML-as-PNG attempt → file lands with `.png` extension,
  not `.html` (the S399 fix pinned)
- Happy: image/png upload → photo_url returned + file on
  disk with `.png` extension

**GET /applications (admin global) — 2 cases**
- Pre-fix would 500 due to /:id route-order collision —
  now returns 200 with applications across all landlords
- Happy: shape includes property + applicant

**POST /:id/units/bulk — 2 cases**
- Cross-landlord → 403
- Happy (S399 fix): bulk-creates N units with prefix +
  sequential numbering, defaults `securityDeposit` to 0
  when omitted

## Files touched

```
apps/api/src/routes/
  properties.ts                          (3 surgical fixes:
                                          route-order hoist
                                          + cross-tenant
                                          check + multer
                                          MIME-derived
                                          extension +
                                          securityDeposit
                                          default)
  properties-gap-close.test.ts          (NEW — ~450 lines,
                                          27 cases)
```

No migrations. No schema changes. No frontend touched.

## Decisions made during build

| Question | Decision |
|---|---|
| Fix the `/applications` route-order bug in the same pass? | **Yes — fix-it-right.** Discovered during recon. Production-broken endpoint, 1-line hoist, no scope expansion. |
| Forcibly normalize multer filenames to MIME-derived extensions, or just reject mismatched uploads? | **Normalize.** Matches the S380/S394/S395 fix shape — defense at the write layer is stronger than relying on consumers to detect mismatch. The original filename is never trusted. |
| Bound `count` on bulk-create in S399? | **No — flag and defer.** The route fix is the security_deposit default; input-hardening is a separate concern that belongs in the validation-hygiene micro-session alongside the other ~19 items. Don't expand S399 scope mid-slice. |
| Test the "HTML masquerading as PNG" attack happy-path landing? | **Yes — pinning the on-disk extension** is the only way to catch a future refactor that re-introduces `originalname` trust. |
| Pin the route-order fix with a real test? | **Yes — admin global `/applications` returning 200**. If a future refactor re-orders the file, the test catches the 500 regression immediately. |

## Verification

- `npx tsc --noEmit` clean on apps/api (0 errors).
- `npm test` in apps/api: **1560 tests across 86 files,
  0 failures**, 904.84s. **Third consecutive fully-green
  full-suite run** since the S397 hookTimeout bump.
- 27 new test cases.
- 4 production bug fixes (route-order + cross-tenant
  scope + XSS class #4 + securityDeposit default).
- 1 architectural finding (bulk-create input hardening).
- 0 production regressions.

## Items deferred — what S400 could target

### High-band files remaining

After properties.ts close:
- **units.ts — 9/17 uncovered (47%)**
- background.ts — 25 routes (Checkr wire-up; credentials
  in hand per memory)

**Recommend S400 = units.ts gap-close.** Smaller surface
than properties.ts (540 lines), peer to properties.ts so
the unit-level / property-level coverage symmetry lands
together. ~16-22 tests expected. Leaves background.ts +
medium-band batch as the final two pre-services arcs.

### Validation-hygiene backlog (now 20 items)

Same as S398 + the S399 bulk-create input hardening
finding (count cap, prefix cap, type allow-list). One
hygiene micro-session ~50 lines + ~20 small pins.

### Pending Nic decisions

Unchanged (S398 product decisions captured in
`project_s398_product_decisions.md` memory; implementation
folds into the validation-hygiene micro-session).

### Per directive: fix all bugs before Checkr

Cumulative bug-sweep totals (post-S399):
- **33 production bug fixes** (+4 in S399)
- 20 architectural / validation findings flagged
- 1560 tests covering ~355 of 506 audited routes (70%)

## Items deferred (cross-session docket, post-S399)

Unchanged from S398 + the bulk-create input hardening
note above.

## Nic-pending

Unchanged.

## What S400 should target

**Recommended: units.ts gap-close** (9 routes uncovered,
540 lines). Peer to properties.ts; lands the
unit-level / property-level coverage symmetry. ~16-22 tests.

**Alternatives:**
- Validation-hygiene micro-session (20-item backlog +
  S398 product decisions implementation)
- Medium-band batch (notifications + bulletin + reports
  + stripe + bankAccounts + payments + terminal +
  posCustomerOnboarding — ~36 routes)
- background.ts gap-close + Checkr wire-up (credentials
  in hand)

---

End of S399 handoff. **properties.ts arc CLOSED at 17/17
routes (100%).** Slice / 27 tests / 4 production bug fixes
/ 1 architectural finding.

1560 tests / 86 files / 0 failures. Third consecutive
fully-green full-suite run.

**33 cumulative production bug fixes shipped across the
bug sweep.**
