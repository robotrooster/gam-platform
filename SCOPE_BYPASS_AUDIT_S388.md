# Cross-tenant scope-bypass pattern audit — S388

Generated 2026-06-01. Triggered by the books.ts arc
(S383–S387) surfacing 8 distinct cross-tenant scope-bypass
bugs in a single file across 5 sessions. The audit asks:
**how many more instances of the same pattern exist
elsewhere in the codebase?**

## Methodology

Three pattern signatures, scanned across every
`apps/api/src/routes/*.ts` non-test file:

### Pattern A — scope ID from `req.body`

Routes that take a scope identifier (`landlordId`,
`tenantId`, `propertyId`, `unitId`, `vendorId`,
`accountId`, `pmCompanyId`, `bookkeeperUserId`) from
`req.body` and use it directly in INSERT/UPDATE/DELETE
without verifying the caller owns it.

**Grep:** `(landlordId|tenantId|propertyId|unitId|
vendorId|accountId|pmCompanyId|bookkeeperUserId)\s*[,}]`
inside `req.body` destructures.

### Pattern B — `user_id` used where `landlord_id` is the trust boundary

Routes that join `landlords WHERE user_id = $N` with
`req.user.userId`, when the actual trust boundary should
be `landlord_id`. Worked by coincidence for landlord
callers but broke for admin and bookkeeper (the S387
pattern).

**Grep:** `landlords\s+WHERE\s+user_id\s*=\s*\$` or
`l\.user_id\s*=\s*\$`.

### Pattern C — `OR $N IS NULL` bypass-eligible predicates

Routes with `WHERE ... = $N OR $N IS NULL` predicates
where the null branch could be reached by a non-admin
caller (the S383 pattern: bookkeeper with no X-Client-Id
got `lid=null`, predicate became `OR TRUE`).

**Grep:** `OR\s+\$[0-9]+\s+IS\s+NULL`.

## Results summary

| Pattern | Files scanned | Hits | Bugs confirmed | Already fixed | False positives |
|---|---:|---:|---:|---:|---:|
| A — scope ID from body | 39 | ~30 | **3 new** | 8 (books.ts S385/S386) | 19 |
| B — user_id as scope | 39 | 3 | 0 (1 fixed in S387) | 1 | 2 (legit user-keyed: fitness, books seed-helper) |
| C — OR $N IS NULL | 39 | **books.ts only** | 0 (secured by S383 middleware) | n/a | 38 files clean |
| **Total new** | — | — | **3** | — | — |

**The cross-tenant scope-bypass pattern outside books.ts
is much rarer than expected.** Audit estimated 5-15 more
instances; the actual count is 3, all LOW-severity. The
high concentration in books.ts was due to its high route
density (40 routes) and historical lack of test coverage,
not a codebase-wide pattern.

## New findings (3 — all LOW-severity)

All three have the same shape as the S385/S386 cluster but
score lower on the severity matrix because they don't
expose another landlord's data — they pollute the caller's
own rows with cross-tenant references. Practical
exploitability requires knowing the foreign UUID
(infeasible to guess) AND benefits the caller in only
narrow ways (e.g., spoofing analytics).

### Finding 1 — `maintenance-portal.ts:191` POST /scheduled

**Lines 193-197:**
```js
const { title, description, recurrence, propertyId, unitId, assignedTo, ... } = req.body
await queryOne(
  'INSERT INTO scheduled_maintenance (landlord_id, ..., property_id, unit_id, assigned_to, ...) VALUES ($1, ..., $5, $6, $7, ...)',
  [req.user!.profileId, ..., propertyId||null, unitId||null, assignedTo||null, ...]
)
```

`propertyId`, `unitId`, and `assignedTo` are passed
straight from the body. No SELECT to verify ownership.
The row is owned by the caller (landlord_id =
profileId), but references can span landlords.

GET /scheduled at line 178 joins properties + units +
users to surface names; a row referencing a stranger's
property would display that property's name in the
caller's scheduled list. Low-severity reference
pollution + fingerprinting opportunity if attacker can
brute-force property UUIDs (infeasible).

**Recommended fix:** before INSERT, validate each
provided id belongs to `req.user!.profileId`:
- `propertyId` → `SELECT 1 FROM properties WHERE id=$1 AND landlord_id=$2`
- `unitId` → same
- `assignedTo` → tighter check — should be a team-role user
  on the caller's landlord

To be applied when maintenance-portal.ts gets its test
slice (per COVERAGE_AUDIT_S382.md priority: critical
band).

### Finding 2 — `esign.ts:1164` POST /documents

**Lines 1167, 1200-1208:**
```js
const { templateId, unitId, title, signers, basePdfUrl, prefillValues } = req.body
...
const resolvedUnitId = await resolveUnitFromPrefill(req.user!.profileId, prefillValues || {})
const finalUnitId = resolvedUnitId || unitId || null
...
await createDocumentRecord(client, { landlordId, unitId: finalUnitId, ... })
```

If `prefillValues` doesn't resolve to a unit, `unitId`
from the body is used as fallback **with no ownership
check**. `createDocumentRecord` doesn't validate either.

Severity: LOW-MED. A malicious landlord can create a
lease document pointing at another landlord's unit.
Practical exploit requires getting a tenant to actually
sign that document. The signed lease then has a
cross-tenant unit_id reference. The victim landlord
wouldn't see this lease (their landlord_id ≠ caller's),
but the unit_id pointer is wrong.

**Recommended fix:** when `unitId` from body is used as
fallback, validate it:
```js
if (unitId && unitId !== resolvedUnitId) {
  const ok = await queryOne(`SELECT 1 FROM units WHERE id=$1 AND landlord_id=$2`, [unitId, req.user!.profileId])
  if (!ok) throw new AppError(403, 'unitId not in your portfolio')
}
```

To be applied when esign.ts test slice runs (critical
band per audit).

### Finding 3 — `pos.ts:189` PATCH /items

**Lines 194-195, 244-250:**
```js
const { ..., vendorId, ... } = req.body
...
const updated = await queryOne(`UPDATE pos_items SET ..., vendor_id=$11, ... WHERE id=$14 RETURNING *`,
  [..., vendorId??item.vendor_id, ..., item.id])
```

`vendorId` is written without validation. The route DOES
validate `categoryId` and `propertyId` (S227 + S192 fixes
above), but `vendorId` slipped through. Same class as
the books.ts bills `vendorId` bug fixed in S386.

Severity: LOW (cross-tenant reference; vendor_id pointer
in your items table can be a stranger's vendor).

**Recommended fix:** mirror the propertyId pattern
(lines 217-231):
```js
if (vendorId !== undefined && vendorId !== null) {
  const v = await queryOne(`SELECT 1 FROM pos_vendors WHERE id=$1 AND landlord_id=$2`, [vendorId, req.user!.profileId])
  if (!v) throw new AppError(400, 'vendorId does not belong to this landlord')
}
```

To be applied during pos.ts test slice (critical band).

## False positives (confirmed clean)

19 of the ~30 Pattern A hits validated as **NOT bugs**.
Worth documenting so future audits don't re-flag them:

### Public routes (caller is anonymous; body params are the input)
- `properties.ts:927` `publicPropertiesRouter.post('/apply')` —
  public application form. landlordId from body is intentional.
- `auth.ts:346` `/register-prospect` — public signup.
  unitId/landlordId in body are stored as JWT metadata
  only (not used for privileged scope decisions).
- `tenants.ts:24` `/accept-invite`, `tenants.ts:119`
  `/invite-info` — pre-auth via invite token.
- `tenants.ts:151` `/avatar-files/:filename` — public
  image serve.

### Service-layer ownership validation
- `landlords.ts:179` `/flex-charge/accounts` POST →
  `createFlexChargeAccount` validates
  `prop.landlord_id === args.landlordId` (line 149 of
  services/flexCharge.ts).
- `notifications.ts:69` `/bulk` — service filters
  `WHERE un.landlord_id = $1` so cross-tenant
  propertyId yields empty recipient list.

### Explicit per-route ownership validation
- `tenants.ts:951` `/invite` — `canAccessLandlordResource
  (req.user, unit.landlord_id)` check at line 968.
- `units.ts:339` `/:id/bookings/:bookingId` PATCH —
  validates `targetUnit.landlord_id === booking.landlord_id`
  at line 355.
- `pos.ts:144` POST /items — explicit category + property
  ownership checks (S227 + S192).
- `pos.ts:301` POST /transactions — landlord_id from
  caller; tenantId/posCustomerId/propertyId validated
  by the transaction service.
- `pos.ts:1135` POST /purchase-orders — vendorId
  validated by service.
- `pos.ts:1571, 1633` POS receipt routes — caller-scoped.

### Caller-keyed primary
- `landlords.ts:182` body fields used after caller's
  profileId is the trust anchor; cross-tenant IDs would
  fail FK or service validation.

## Pattern B — fitness.ts is fine

`fitness.ts:183, 190` use `req.user.userId` against
`fitness_set_logs.user_id`. This IS the correct trust
boundary — each user's fitness logs are owned by their
user_id (not landlord scope). Not a bug; the audit
correctly distinguishes "user-keyed" data from
"landlord-keyed" data.

## Pattern C — books.ts only, already secured

The `OR $N IS NULL` bypass-eligible predicate appears
in **38 of 39 routes/*.ts files: only books.ts uses
this pattern.** Every books.ts route is now secured by
the S383 X-Client-Id middleware (bookkeepers cannot
reach the route body with `lid=null`).

The pattern was an architectural choice unique to
books.ts; the rest of the codebase uses explicit
ownership checks. No further fixes needed.

## Recommended remediation

Per the LOW severity of all 3 new findings, my
recommendation: **fix during normal test-slice work**
on each respective file, not as standalone hot fixes.
The relevant slices per COVERAGE_AUDIT_S382.md:

| Finding | File | Audit priority | Estimated session |
|---|---|---|---|
| #1 | maintenance-portal.ts | Critical (17/17 uncovered) | S391–S392 |
| #2 | esign.ts | Critical (16/25 uncovered) | S393–S396 |
| #3 | pos.ts | Critical (23/55 uncovered) | S389–S390 |

Each fix is 4-6 lines. Bundled with the slice's other
test cases, the cost is marginal.

**Alternative:** apply all 3 fixes in one micro-session
without tests. Tradeoff: smaller diffs land sooner, but
no regression-pin until the file's slice runs. Given
LOW severity, the test-slice path is fine.

## What this audit did NOT cover

- Services (`apps/api/src/services/*.ts`) — same audit
  on the service layer is a separate one-session pass
  if Nic wants it.
- Jobs (`apps/api/src/jobs/*.ts`) — same.
- Frontend (`apps/*/src/`) — out of scope; backend audit.
- Read paths that JOIN to cross-tenant data without an
  explicit `landlord_id = $N` filter. (Audit focused on
  WRITE paths; read paths are a different pattern.)
- Static helpers / middleware / libs — out of scope.

## Audit conclusion

The S383–S387 books.ts arc surfaced 8 bugs because
books.ts had high route density × zero prior coverage ×
custom scope-helper pattern (the `lid` variable). The
codebase-wide audit found **3 more LOW-severity
instances** in maintenance-portal, esign, and pos —
not the 5-15 predicted.

This is **good news**: the rest of the codebase generally
follows the right pattern (explicit ownership checks at
the route or service layer). books.ts was an outlier;
the post-S387 books.ts is now consistent with the rest.

The 3 findings can be folded into the upcoming
test-slice work on each respective file. No urgent
hot-fix needed.
