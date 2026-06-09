# Session 411 — closed

## Theme

**Third validation-hygiene micro-session. S380 email
validation shipped on `PATCH /api/tenants/profile` —
all three Nic-locked sub-fixes plus a 4th defensive
case.**

Suite at S410 close: **1798 / 96 files**.
Suite at S411 close: **1808 / 97 files** (+10 cases,
+1 file). 0 failures. Runtime 1398.30s. Fifteenth
consecutive fully-green full-suite run.

Zero tsc regressions.

## What shipped (S398 locked decision S380)

The Nic-locked decision was 3 sub-fixes; I shipped a
4th defensive case discovered during recon.

### Pre-fix behaviors on `PATCH /api/tenants/profile`

1. **No format check** — any string accepted as email
   value (`'not-an-email'` would land in the DB).
2. **No uniqueness pre-check** — a duplicate email
   hit the `users.email` DB UNIQUE constraint and
   returned 500 with a cryptic postgres error string.
   The tenant saw "internal server error" with no
   guidance.
3. **No disposable-domain block** — mailinator /
   yopmail / 10minutemail addresses passed straight
   through, defeating the email-verification gate
   downstream.
4. **(Defensive)** When `email` was omitted from the
   request body, the destructured value was
   `undefined` → pg bound it as null → `SET email=NULL`
   → 23502 NOT NULL violation → 500. Editing only
   bio/phone returned 500.

### Fixes shipped

```ts
const DISPOSABLE_EMAIL_DOMAINS = new Set([
  'mailinator.com', 'guerrillamail.com', 'guerrillamail.net',
  'sharklasers.com', '10minutemail.com', 'tempmail.com',
  'temp-mail.org', 'throwawaymail.com', 'trashmail.com',
  'yopmail.com', 'maildrop.cc', 'getnada.com',
  'dispostable.com', 'fakeinbox.com', 'mintemail.com',
])

const profileSchema = z.object({
  phone:       z.string().nullish(),
  email:       z.string().trim().email('Invalid email format').nullish(),
  bio:         z.string().nullish(),
  themeAccent: z.string().nullish(),
  fontStyle:   z.string().nullish(),
})

// In the handler:
if (email) {
  const normalized = email.trim().toLowerCase()
  if (isDisposableEmail(normalized)) {
    throw new AppError(400, 'Disposable / temporary email addresses are not allowed')
  }
  const existing = await queryOne<{ id: string }>(
    `SELECT id FROM users WHERE LOWER(email) = $1 AND id != $2 LIMIT 1`,
    [normalized, req.user!.userId])
  if (existing) {
    throw new AppError(409, 'This email is already in use by another account')
  }
  await query('UPDATE users SET phone=$1, email=$2 WHERE id=$3',
    [phone||null, normalized, req.user!.userId])
} else {
  // Preserve existing email when omitted.
  await query('UPDATE users SET phone=COALESCE($1,phone) WHERE id=$2',
    [phone||null, req.user!.userId])
}
```

Notable choices:
- **`LOWER()`-compare on uniqueness check** so
  case-only collisions (Alice@x.com vs alice@x.com)
  are caught.
- **`!= $2` (exclude self) on the uniqueness check**
  so a no-op update to the current email returns 200,
  not 409.
- **`.trim().email()`** on the zod schema so
  surrounding whitespace doesn't fail format
  validation.
- **Hand-curated 15-domain disposable list** instead
  of the `disposable-email-domains` npm package. The
  dependency cost outweighs the curated list value
  for launch; future hygiene can swap if domain
  drift becomes painful.
- **Empty string treated as invalid** (zod email rejects)
  rather than as "preserve current" — empty string is
  explicit user input, not omission.

## Items shipped

### Test coverage — 10 cases (new file)

New file: `apps/api/src/routes/s411-email-validation.test.ts`
(~190 lines)

**Format check — 2 cases**
- Non-email string → 400 + row not updated
- Empty string → 400

**Uniqueness pre-check — 3 cases**
- Collision with another user → 409 (was 500 pre-fix)
- Case-insensitive collision (MIXED vs mixed) → 409
- Updating to OWN current email → 200 (not flagged)

**Disposable-domain block — 3 cases**
- mailinator.com → 400
- yopmail.com (case-insensitive) → 400
- gmail.com not blocked (legit address) → 200

**Preserve on omit — 1 case**
- Missing email + phone/bio update → 200; email row
  unchanged (was 500 from NOT NULL pre-fix)

**Normalization — 1 case**
- Mixed-case + whitespace → stored as lowercase trimmed

## Files touched

```
apps/api/src/routes/
  tenants.ts                           (1 substantive:
                                         /profile route
                                         + disposable
                                         domain const +
                                         zod schema +
                                         helper)
  s411-email-validation.test.ts        (NEW — ~190
                                         lines, 10 cases)
```

No migrations. No schema changes. Existing
tenants-self-edit.test.ts (2 happy-path tests) still
passes unmodified — they used well-formed emails so
the new validation doesn't affect them.

## Decisions made during build

| Question | Decision |
|---|---|
| Hand-curated list vs npm package for disposable domains? | **Hand-curated 15-entry Set.** Dependency cost > curated list value for launch posture. Future swap is trivial. |
| Block disposable check before or after uniqueness? | **Before.** Disposable is a hard policy reject; doesn't matter who else has the address. Cheaper check too (no DB hit). |
| Treat empty-string email as "preserve" or "invalid"? | **Invalid (400).** Empty string is explicit user input; "preserve current" is a different signal (field omitted). Conflating them would let frontend accidentally null-clobber the email by sending `email: ''`. |
| Trim on the schema vs trim in the handler? | **Schema (`z.string().trim().email()`).** Single normalization point; the handler then re-lowercases for DB write. Two steps in case trim wasn't enough (it always is, but the lowercase pass is required for case-insensitive storage). |
| Add disposable-domain check to OTHER email-accepting routes (register, invite)? | **No — out of scope for S380.** The locked decision is "Profile email edit". Future hygiene could fan-out the `isDisposableEmail` helper, but bundling now widens the diff. |
| Extract `isDisposableEmail` to a lib file? | **No — inline.** Single caller today; if a second route needs it, extract then. |

## Verification

- `npx tsc --noEmit` clean on apps/api (0 errors).
- `npm test` in apps/api: **1808 tests across 97 files,
  0 failures**, 1398.30s. **Fifteenth consecutive
  fully-green full-suite run.**
- 10 new test cases pinning the 4 fixes.
- 0 production regressions (existing tenants-self-edit
  happy-path tests still pass).

## Items deferred — what S412 could target

### Validation-hygiene backlog (was 24, now 23)

Shipped in S411: S380 email validation.

Remaining locked S398 decisions (3):
- S384 contractor: ALL fields required
- S386 overpayment: vendor credit_balance schema +
  confirmation modal flow
- S377 (a) — deferred (email dispatch blocked)

Other hygiene items (~20):
- Disposable-domain fan-out to other email-accepting
  routes (register, invite) — NEW S411-spawned item
- Test infra: single-file vitest uses dev DB
- S399 bulk-create input hardening
- S400 LEASE_TYPE_MATRIX ↔ CHECK drift
- S403 cross-landlord PI capture/cancel
- S405 bank_last4 null + ach_verified=TRUE defensive
- S405 /complete missing isExpired check
- S407 UNIQUE constraint on payments
- S408 finding A (monthly-statement off-by-one default
  — Nic-pending)
- S408 finding B ($15 hardcoded fee — Nic-pending)

### Per directive: fix all bugs before Checkr

Cumulative bug-sweep totals (post-S411):
- **44 production bug fixes** (S411 is a security-
  tightening refactor; no NEW bug discoveries, just
  closes 3 known issues)
- 23 architectural / validation findings remaining
- 1808 tests across 97 files

## What S412 should target

**Recommended: S384 contractor required fields** —
next-smallest locked S398 decision. Nic-stated
literally: "all fields required" on POST /contractors.
Implement the validator. If during implementation a
specific field turns out to make individual-contractor
(no EIN) or no-SSN-on-file cases impossible, flag
back to Nic before relaxing (per S398 memory).

**Alternatives:**
- S386 vendor overpayment (schema migration + UX)
- Test infra fix (single-file run wrong DB)
- Smaller bundle: bulk-create input hardening +
  matrix drift fix
- Checkr wire-up

---

End of S411 handoff. **S380 email validation shipped:
4 fixes on /tenants/profile (3 Nic-locked + 1
defensive). 10 new tests pinning each.**

1808 tests / 97 files / 0 failures. Fifteenth
consecutive fully-green full-suite run.

**44 cumulative production bug fixes shipped across the
bug sweep.** Validation-hygiene backlog reduced from
24 to 23.
