# Session 409 — closed

## Theme

**First validation-hygiene micro-session. Four small
fixes shipped in one slice — 1 product-decision label,
2 input-validation hardenings, 1 XSS strong fix (Nic-
locked decision).**

Suite at S408 close: **1782 / 95 files**.
Suite at S409 close: **1798 / 96 files** (+16 cases,
+1 file). 0 failures. Runtime 1193.21s. Thirteenth
consecutive fully-green full-suite run.

Zero tsc regressions.

## Fixes shipped (4)

### 1. S376 (S398-locked Nic decision): admin "FlexCredit enrolled" label rename

**Severity: low (label mislabel; no functional impact)
— but locks the broader rule that landlord portal never
surfaces rent reporting at all.**

The `tenants.credit_reporting_enrolled` column IS the
rent-reporting product (tenant pays to have rent
reported to Equifax/Experian/TransUnion). Pre-fix the
admin onboarding checklist labeled it "FlexCredit
enrolled" — which is wrong on two counts: (1)
FlexCredit is a separate third-party-lender referral
product per CLAUDE.md; (2) the rent-reporting label
also needs to be admin-only (per the broader rule in
memory: landlord portal has zero knowledge of any
tenant-facing product).

**Fix:**
- `apps/api/src/routes/admin.ts:267` — label changed to
  "Rent reporting enrolled" on the
  `GET /onboarding/tenant/:id` checklist.
- `apps/admin/src/main.tsx:517` — dashboard tile
  "💳 Credit" → "💳 Rent reporting".
- SQL aliases `flex_credit` left intact (data-shape key
  the frontend consumes; renaming risks frontend break).

### 2. S402a (validation hygiene): GET /api/notifications limit clamping

**Severity: low (self-DoS only).** Pre-fix used
`parseInt(limit) || 20`:
- Negative values bypassed the `|| 20` fallback → SQL
  `LIMIT -1` → postgres 22023 → 500
- Unbounded positive values (`?limit=999999`) → giant
  result, no cap

**Fix:** clamp to `[1, 200]`:
```ts
const rawLimit = parseInt(req.query.limit as string)
const limit = Number.isFinite(rawLimit) && rawLimit > 0
  ? Math.min(rawLimit, 200)
  : 20
```

### 3. S402b (validation hygiene): PATCH /preferences body validation

**Severity: low (data hygiene).** Pre-fix accepted any
string for `type` (could spam arbitrary garbage into
the prefs table) and trusted body booleans as-is.

**Fix:** zod schema:
```ts
const prefsPatchSchema = z.object({
  type:         z.string().regex(/^[a-z][a-z0-9_]{0,63}$/, 'type must be snake_case, ≤64 chars'),
  emailEnabled: z.boolean(),
  smsEnabled:   z.boolean(),
  inAppEnabled: z.boolean(),
})
```

Soft validation (snake_case + length) over hard
allow-list — codebase has 15+ notification types and
growing, so a hard list would be high-maintenance.

### 4. S380 (S398-locked Nic decision): avatar XSS strong fix

**Severity: medium (XSS class — 5th instance closure
in the sweep arc).**

Pre-fix had two attack surfaces:
- Upload (`POST /tenants/avatar`): multer stored file
  with `path.extname(originalname)` — client-controlled.
  An attacker could upload `xss.html` with
  `Content-Type: image/jpeg` and the file would land
  as `<random>.html`.
- Serve (`GET /tenants/avatar-files/:filename`):
  `res.sendFile(fp)` lets express derive Content-Type
  from extension. A `.html` file on disk would be
  served as `text/html` → browser executes HTML in
  same-origin context.

**Fix — belt and suspenders (Nic-decided "strong fix"
posture):**

Layer 1 (upload):
```ts
const AVATAR_MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp',
}
filename: (_req, file, cb) => {
  const ext = AVATAR_MIME_TO_EXT[file.mimetype] ?? '.jpg'
  cb(null, Date.now() + '-' + crypto.randomBytes(8).toString('hex') + ext)
}
```

Layer 2 (serve):
```ts
res.setHeader('Content-Type', /* derived from ext, defaulting to image/jpeg */)
res.setHeader('X-Content-Type-Options', 'nosniff')
```

The serve-layer pinning protects legacy files on disk
from any pre-S409 upload (since the contract is "this
is an avatar; force image/*"); the upload-layer
normalization prevents new bad files from landing.

## Items shipped

### Test coverage — 16 cases in one slice

New file: `apps/api/src/routes/s409-hygiene.test.ts`
(~290 lines)

**S376: admin checklist label — 1 case**
- GET /admin/onboarding/tenant/:id returns "Rent
  reporting enrolled" (not "FlexCredit enrolled")

**S402a: GET /notifications limit clamping — 5 cases**
- limit=-1 → no 500, falls back to default 20
- limit=0 → falls back to default 20
- limit=99999 → clamped to 200
- limit=garbage → falls back to default 20
- limit=2 → still works

**S402b: PATCH /preferences body validation — 6 cases**
- Happy path: valid snake_case type accepted
- Rejects type with uppercase letters → 400
- Rejects type with spaces → 400
- Rejects type > 64 chars → 400
- Rejects non-boolean emailEnabled → 400
- Rejects missing required field → 400

**S380: avatar XSS strong fix — 4 cases**
- POST /avatar normalizes extension from MIME (not
  originalname); attempt to upload `xss.html` lands
  as `.jpg`
- GET /avatar-files/:filename serves with
  `Content-Type: image/*` + `X-Content-Type-Options:
  nosniff`, even when on-disk ext is `.html` (legacy
  defense)
- GET /avatar-files/:filename Content-Type matches
  on-disk extension when image-typed
- POST /avatar rejects non-image MIME (multer
  fileFilter)

## Files touched

```
apps/api/src/routes/
  admin.ts                             (1 surgical:
                                         "FlexCredit
                                         enrolled" →
                                         "Rent reporting
                                         enrolled")
  notifications.ts                     (2 surgicals:
                                         limit clamp +
                                         prefs zod
                                         validation)
  tenants.ts                           (2 surgicals:
                                         avatar serve
                                         Content-Type
                                         pin + upload
                                         ext normalize)
  s409-hygiene.test.ts                 (NEW — ~290
                                         lines, 16 cases)

apps/admin/src/
  main.tsx                             (1 surgical:
                                         "💳 Credit"
                                         tile label →
                                         "💳 Rent
                                         reporting")
```

No migrations. No schema changes.

## Decisions made during build

| Question | Decision |
|---|---|
| Soft validation (regex) or hard allow-list on PATCH /preferences `type`? | **Soft regex (snake_case + length).** 15+ types in codebase + growing; hard list would need updates every time a new notification type lands. Soft validation catches the realistic abuse (arbitrary garbage spam) without per-type maintenance. |
| Update SQL alias `flex_credit` → `rent_reporting`? | **No — alias kept.** The admin frontend may consume `flex_credit` as a JSON response key; renaming risks UI break for low payoff. The user-visible LABEL was the actual S376 bug; SQL alias is internal data-shape. |
| Pin BOTH the upload + serve layers in the avatar fix? | **Yes — belt-and-suspenders per Nic-locked "strong fix" posture.** Serve-layer protects legacy files; upload-layer prevents new ones. Single-layer fix would leave one foot exposed. |
| Pin the "legacy .html file on disk → still served as image/*" case? | **Yes — exactly the scenario the serve-layer fix protects.** A future refactor that removes the Content-Type header would only break THIS test, making the regression visible. |
| Test admin-frontend label change with a unit test? | **No.** Frontend label changes are visual; the API contract test (admin.ts checklist) plus the diff in main.tsx is the audit trail. UI smoke is for Nic's walkthrough. |

## Verification

- `npx tsc --noEmit` clean on apps/api (0 errors).
- `npm test` in apps/api: **1798 tests across 96 files,
  0 failures**, 1193.21s. **Thirteenth consecutive
  fully-green full-suite run.**
- 16 new test cases.
- 4 hygiene fixes shipped (1 product decision, 2
  input-validation, 1 XSS strong fix).
- 0 production regressions.

## Items deferred — what S410 could target

### Validation-hygiene backlog (was 29, now 25)

Shipped in S409: S376, S402a, S402b, S380.

Remaining locked S398 decisions (5):
- S377 invite token (3 sub-fixes — schema migration to
  split email_verify_token into 3 columns, 7d expiry,
  stop returning token in API response)
- S380 email validation (3 sub-fixes — format,
  uniqueness pre-check, disposable domain block)
- S384 contractor: ALL fields required (validator
  tightening)
- S386 overpayment: vendor credit_balance schema +
  confirmation modal flow

Other hygiene items (~20):
- S399 bulk-create input hardening (count cap, prefix
  cap, type allow-list)
- S400 LEASE_TYPE_MATRIX ↔ CHECK drift
- S403 cross-landlord PI capture/cancel
- S405 bank_last4 null + ach_verified=TRUE defensive
- S405 /complete missing isExpired check
- S407 UNIQUE constraint on payments
  (unit_id, type, due_date)
- S408 finding A (monthly-statement off-by-one
  default — Nic-pending)
- S408 finding B ($15 hardcoded fee in 3 routes —
  Nic-pending)
- + earlier carry-forwards from the sweep

### Pending Nic decisions

Two new from S408:
- A: monthly-statement default month (deliberate or
  fix?)
- B: $15 hardcoded fee approach (historical actual via
  platform_fee_accruals or current rate?)

Plus the 6 S398 decisions remain locked + actionable
(5 still to ship; S376/S380 strong avatar shipped this
session).

### Per directive: fix all bugs before Checkr

Cumulative bug-sweep totals (post-S409):
- **44 production bug fixes** (no NEW bugs surfaced —
  the 4 S409 fixes are hygiene tightenings, not bug
  discoveries; the S376/S380 product-decision fixes
  were Nic-locked from S398)
- 25 architectural / validation findings remaining
  (was 29; -4 shipped)
- 1798 tests across 96 files

## What S410 should target

**Recommended: continue hygiene batch.** Next bundle:

1. **S377 invite token hardening (the 3 sub-fixes)** —
   biggest locked decision still pending. Schema
   migration + route changes. ~30-60 min session.
2. **OR continue with smaller bundle:**
   - S399 bulk-create input hardening (count cap +
     prefix length cap)
   - S403 cross-landlord PI capture/cancel
   - S407 UNIQUE constraint migration on payments

S377 is the largest remaining locked decision; closing
it gets one major S398 item off the docket. Recommend
S410 = S377.

**Alternatives:**
- Continue small hygiene bundles (3-4 fixes per
  session)
- Checkr wire-up (background.ts)
- Services audit (~30 sessions)

---

End of S409 handoff. First validation-hygiene
micro-session: 4 fixes shipped (S376 label, S402a/b
notifications validation, S380 avatar XSS strong fix).
16 tests pinning each.

1798 tests / 96 files / 0 failures. Thirteenth
consecutive fully-green full-suite run.

**44 cumulative production bug fixes shipped across the
bug sweep.** Validation-hygiene backlog reduced from 29
to 25.
