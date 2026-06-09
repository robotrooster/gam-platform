# Session 450 — closed

## Theme

**Second post-services-audit session. `auth.ts` core
surface — the biggest small-uncovered route file (578
lines, 10 endpoints) had partial coverage from 5 themed
files (loginLockout, emailVerification, passwordReset,
totp, s417-disposable-email) but the core happy paths +
worker-scope dispatch + /me shape + /refresh + PATCH /me
+ /register-prospect had ZERO direct coverage. 35 cases
shipped. **One production bug found and fixed**:
`POST /api/auth/refresh` was completely broken —
re-signing the verified JWT with `expiresIn` set while
payload already carried `exp` caused jsonwebtoken to
throw, returning 500 on every refresh call.**

Suite at S449 close: **2724 / 146 files**.
Suite at S450 close: **2759 / 147 files** (+35 cases,
+1 file — exactly 35 new cases here). 0 failures.
Runtime **76.54s**. Fifty-third consecutive
fully-green full-suite run.

Zero tsc regressions.

## What shipped

### `routes/auth.test.ts` — 35 cases (NEW file)

Pattern from loginLockout.test.ts: mock `services/email`
sendVerifyMock + sendResetMock at module level so the
fire-and-forget verification email calls don't hit Resend.

**POST /api/auth/register (7)**
- Happy landlord: 201 + token + landlord profile row +
  accepted_tos_at/accepted_privacy_at stamped + 
  email_verified=false (no auto-verify)
- Happy tenant: tenant profile row, role=tenant in token
- acceptedTerms missing → 400 (zod literal(true) refuses)
- acceptedTerms=false → 400
- password under 12 chars → 400
- Duplicate email → 409 'Email already registered'
- Invalid role ('admin' on public path) → 400 (zod enum)
- Verification email fired AFTER commit (best-effort)

**POST /api/auth/login (6)**
- Happy landlord: token + user shape, mustEnrollTotp=false
- property_manager WITH scope: landlordId + permissions
  on user object AND on the JWT claims (decoded check)
- Worker WITHOUT scope row → 403 deactivated
- mustEnrollTotp=false for non-mandatory roles (MANDATORY_TOTP_ROLES
  = admin/super_admin only — corrected from initial
  test-author assumption that PM was in the set)
- bcrypt mismatch → 401 generic
- Missing email → 400 (zod)

**GET /api/auth/me (7)**
- Landlord: full shape + bank_account_ready=false +
  totpEnabled=false + mustEnrollTotp=false
- Tenant: surfaces ach_verified + on_time_pay_enrolled +
  credit_reporting_enrolled
- Worker (PM) with scope: landlord_id (snake) + landlordId
  (camelCase mirror) + permissions + directDepositEnabled
- Active bank_account → bank_account_ready=true
- Archived bank_account → bank_account_ready=false (only
  status='active' counts; corrected from initial use of
  the invalid 'inactive' status value — the CHECK only
  allows active/archived)
- No auth → 401
- Deleted user (valid token, no row) → 404

**POST /api/auth/refresh (2)**
- Happy: re-signs with same claims (decoded check pins
  userId + role); **passing only after the production fix
  below**
- No auth → 401

**PATCH /api/auth/me (4)**
- Updates firstName + lastName + phone
- COALESCE: omitted fields preserve current values
  (set Initial/Last/111, then patch only firstName=Updated
  → lastName stays 'Last', phone stays '111')
- Only updates caller's row (cross-user attempt does not
  mutate other landlord's row)
- No auth → 401

**POST /api/auth/register-prospect (9)**
- Happy: 201 + tenant profile + ToS timestamps
- landlordId in body stamps the JWT (for downstream lease
  attribution)
- No landlordId → JWT carries landlordId=null
- acceptedTerms missing → 400
- Password under 12 chars → 400 (manual check before bcrypt)
- Duplicate email → 409 with 'Please sign in' hint
- Missing firstName → 400 'required'
- Verification email fired (best-effort)

### Production bug — `POST /api/auth/refresh` returns 500

**Caught by the very first refresh test case.**

Pre-fix:
```ts
authRouter.post('/refresh', requireAuth, (req, res) => {
  const token = signToken(req.user!)
  res.json({ success: true, data: { token } })
})

function signToken(payload: object) {
  return jwt.sign(payload, process.env.JWT_SECRET!, { expiresIn: '7d' })
}
```

`requireAuth` calls `jwt.verify`, which returns the payload
with `iat` and `exp` set. `signToken(req.user)` then calls
`jwt.sign(payload, secret, { expiresIn: '7d' })` — but
jsonwebtoken explicitly refuses this: when `expiresIn`
option is set AND payload already has `exp`, it throws
`Bad "options.expiresIn" option the payload already has an "exp" property`.
**Result in production: every authenticated /refresh call
returns 500.** No prior test exercised this path so it
went undetected.

**Fix:** strip `iat` and `exp` from the verified payload
before re-signing. One-line destructure:
```ts
const { iat, exp, ...claims } = req.user as any
const token = signToken(claims)
```

Comment block added explaining why the strip is necessary
so future readers don't restore the broken shape.

## Items shipped

```
apps/api/src/routes/
  auth.ts                               (+5 lines, -1 line — /refresh fix)
  auth.test.ts                          (NEW — 35 cases)
```

## Decisions made during build

| Question | Decision |
|---|---|
| Test login lockout / TOTP / email-verify here too? | **No — already covered.** loginLockout.test.ts + totp.test.ts + emailVerification.test.ts collectively cover those branches. This slice fills the gap: happy paths + worker-scope dispatch + /me shape + the two routes (/refresh + PATCH /me + /register-prospect) that had NO coverage at all. |
| Pin worker-role scope dispatch on /login AND /me? | **Yes — they're separate code paths.** /login calls `getScopeForUser` to mint the JWT; /me re-fetches the scope on every request (the docstring notes: "Source of truth is the scope table (re-fetched, not cached on the JWT) so toggle changes land on the next /me without forcing logout"). A regression that cached the scope on the JWT would break the deliberate-design ergonomics. Pin both paths separately. |
| Fix the /refresh prod bug in this same pass? | **Yes — fix-it-right.** Caught by the first refresh test case. Production /refresh was 100% broken (every authenticated call 500s). One-line fix; the test pins it so the regression can't sneak back. Per CLAUDE.md: "When touching a file and discovering pre-existing bugs, fix them in the same pass." |
| Test the email-fire side effect with `await` or fire-and-forget tolerance? | **50ms tolerance.** The route uses `void mintAndSendVerifyEmail(...)` so the call doesn't await the email send. The test gives the event loop one tick to flush, then asserts the mock was called. Tight enough to catch regressions where the call gets dropped entirely; loose enough to avoid flakes on slow CI. |
| Test the user_bank_accounts schema correctly? | **Required schema lookup.** First-pass test used `plaid_account_id` + status='inactive' (neither exists / is allowed). Corrected to use the actual columns (account_holder_name + account_type + account_number_encrypted) and the actual valid status values (active/archived only). |
| Pin MANDATORY_TOTP_ROLES contents? | **No — pin the BEHAVIOR.** Initial test assumed PM was in the set; lib/totp.ts shows only admin/super_admin. Renamed the test to assert what the code actually does (mustEnrollTotp=false for non-mandatory roles), with a comment noting the actual set. A regression that broadened the set would surface in admin-portal tests, not here. |
| Decode JWT in tests to verify claims, or trust the response shape? | **Decode.** The response surfaces user data the frontend reads from the body; the JWT claims drive downstream `requireAuth` + scope-dispatch. They're related but not identical — the /login test pins both that the body has the landlordId AND that the JWT carries it (so refresh + downstream auth still works). |

## Verification

- `npx tsc --noEmit` clean on apps/api (0 errors).
- `npm test` in apps/api: **2759 tests across 147 files,
  0 failures**, 76.54s. **Fifty-third consecutive
  fully-green full-suite run.**
- 35 new test cases in this slice.
- 1 production bug fix (`/refresh` JWT exp conflict).
- 0 test-infra issues this session.

### Bugs caught during test authoring

1. **`POST /api/auth/refresh` returns 500 in production**
   — re-signing verified JWT payload with expiresIn while
   payload carries exp causes jsonwebtoken to throw. 100%
   broken endpoint. Fixed by stripping iat/exp before
   re-sign. Pinned by `> happy: returns a new token signed
   with same claims`.

2. **(Author's own test bugs, caught by first run)**
   - `user_bank_accounts.plaid_account_id` doesn't exist;
     used the wrong column. Schema lookup → actual columns
     pinned. Also: status='inactive' is invalid (CHECK
     allows active/archived only). Switched to 'archived'.
   - MANDATORY_TOTP_ROLES does NOT include property_manager
     (admin/super_admin only). Two assertions corrected
     based on lib/totp.ts contents.

## Routes audit — progress

Post-S450:

### Direct coverage on auth.ts core

7 themed + 1 core test file now exercise auth.ts:
- emailVerification.test.ts
- s417-disposable-email.test.ts
- loginLockout.test.ts
- totp.test.ts
- passwordReset.test.ts
- **S450: auth.test.ts** — happy paths + worker scope +
  /me + /refresh + PATCH /me + /register-prospect

### Routes still uncovered

```
announcements.ts          (20 lines — stub)
background.ts             (1095 lines — partial via
                           background.test.ts + checkrProvider;
                           full slice deferred)
books.ts                  (large — partial test)
documents.ts              (32 lines — stub-like)
fitness.ts                (size TBD — standalone subsystem)
subleaseInvitations.ts    (269 lines — money-adjacent;
                           paired with subleases tests already
                           partial)
tenants.ts                (large — partial via
                           tenants-profile-dashboard.test.ts)
```

auth.ts CLOSED.

## Items deferred — what S451 could target

### Continue route audit

**Recommend S451 = `subleaseInvitations.ts` route slice.**
269 lines, money-adjacent (sublease setup → credit pulls,
deposit handling). Existing subleases.test.ts covers the
core sublease flow but not the invitations surface.
Single-session slice.

**Alternatives:**
- background.ts route slice (Checkr integration layer,
  large but high-value security path)
- books.ts (large, would need scoping to one part of
  surface)
- Surface S408 / posTax-rounding findings to Nic to
  unblock the validation-hygiene backlog

### Validation-hygiene backlog (16 items, mostly Nic-pending)

Unchanged. S450 didn't reduce.

### Cumulative bug-sweep totals (post-S450)

- **55 production / infra bug fixes** (S449 54 + auth
  /refresh JWT exp conflict) + 1 documented finding (posTax
  rounding mismatch from S439, still pending Nic decision)
- 16 architectural / validation findings remaining
  (Nic-pending)
- 2759 tests across 147 files
- Suite baseline: **66-77s on a clean machine**

## What S451 should target

**Recommended: `subleaseInvitations.ts` route slice** —
money-adjacent, 269 lines, single-session. After that,
background.ts (Checkr integration layer) is the next
biggest uncovered surface.

**Alternatives:**
- background.ts route slice
- Surface S408 / posTax-rounding to Nic

---

End of S450 handoff. **auth.ts core surface shipped — 35
tests covering /register (happy + ToS gate + dup + weak
password + role enum + email side-effect), /login (happy
+ worker-scope dispatch + deactivated worker + bcrypt fail
+ mustEnrollTotp computation), GET /me (landlord/tenant/
worker shapes + bank_account_ready + camelCase mirror),
POST /refresh (re-mint with same claims), PATCH /me
(COALESCE partial + cross-user isolation), and
/register-prospect (happy + ToS + landlordId attribution
+ field validation).**

Plus the prod-blocking `/refresh` 500 fix (jsonwebtoken
expiresIn vs payload-exp conflict; broke every refresh
call).

2759 tests / 147 files / 0 failures. Fifty-third
consecutive fully-green full-suite run.

**55 cumulative production / infra bug fixes** + 1
documented finding still pending Nic review. Route audit
continues; auth.ts CLOSED.
