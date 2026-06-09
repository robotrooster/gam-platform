# Session 277 — closed (Auth hardening audit)

## Theme

Read-only investigation of the two DEFERRED auth items:
"Password reset flow: needs verification it exists end-to-end" +
"JWT expiry + refresh strategy: verify tokens don't live forever."
Plus a sweep for anything else launch-relevant in the auth surface.

No code changes. Findings + recommendations only.

## Findings

### JWT lifecycle — OK with caveats

| Aspect | State |
|---|---|
| Token expiry | `expiresIn: '7d'` (`auth.ts:72`). ✓ Not forever. |
| Refresh endpoint | `POST /api/auth/refresh`, `requireAuth`-gated (`auth.ts:212`). Issues a new token with the same payload. ✓ Standard "extend on active use" pattern. |
| Verify uses non-null `JWT_SECRET!` | `middleware/auth.ts:33`. Throws if env unset, which fails-closed (no fallback to a default secret). ✓ |
| Sign path uses non-null `JWT_SECRET!` | **PARTIAL.** `auth.ts:72` (login + register) ✓. Two sign sites fall back to a hardcoded `'gam_dev_secret'` if env unset — see CRITICAL below. |
| Server-side revocation | None — JWT is stateless. A leaked token is valid until natural expiry (≤7d). No /logout endpoint either (logout is client-side `localStorage.removeItem`). |
| Bcrypt cost | 12 (`auth.ts:82`, `auth.ts:241`). ✓ Standard for 2026. |

### Password reset — NOT IMPLEMENTED

- Schema columns exist: `users.reset_token`, `users.reset_token_expires`
  (initial-schema migration, line 1886-1887; current schema line 4149-4150).
- **No route reads or writes them.** `grep reset_token` across
  `apps/api/src` returns only the schema definitions.
- **No frontend "Forgot password" surface.** `grep` for
  `forgot.password` / `reset.password` across all 9 portals → zero
  hits.
- Effect: a user who forgets their password has no self-service
  recovery path. Recovery requires direct DB intervention
  (super_admin or operator) to overwrite the bcrypt hash.

### CRITICAL — `JWT_SECRET` fallback to hardcoded string

Two public-facing token-issuing endpoints fall back to a literal
hardcoded secret if `process.env.JWT_SECRET` is unset:

- `apps/api/src/routes/auth.ts:269` — `register-prospect`
  (public tenant signup from listings).
- `apps/api/src/routes/subleaseInvitations.ts:246` — sublease
  invitation accept (mints a tenant token).

```ts
const token = jwt.sign(
  { ... },
  process.env.JWT_SECRET || 'gam_dev_secret',
  { expiresIn: '7d' },
)
```

The literal string `'gam_dev_secret'` is in the repo. An attacker
who got the source (it's distributed to many devices) could forge
valid tokens for any `userId` IF `JWT_SECRET` was ever unset in
prod (env-var typo, deploy misconfig, container rebuild without
the env wired).

Mitigating factor: `middleware/auth.ts:33` uses `JWT_SECRET!` for
verify, which throws when unset. So in practice the API would
refuse to verify any token (everyone logged out) the moment
`JWT_SECRET` becomes unset — making the fallback unexploitable in
isolation. But the fallback is footgun-y: a misconfigured prod
deploy that ALSO set the verify path's default to the same literal
(or the next refactor that "fixes" the verify throw by adding a
fallback) would unlock the attack.

**Recommendation**: replace `|| 'gam_dev_secret'` with `!` (non-null
assertion) in both sites. Match the rest of the codebase. One-line
fixes:

```diff
- process.env.JWT_SECRET || 'gam_dev_secret',
+ process.env.JWT_SECRET!,
```

### Important — login hardening gaps

- **No per-account lockout** after N failed login attempts. Rate
  limiter (`100 req / 15 min`) on `/api/auth/*` is per-IP, not
  per-account. A distributed credential-stuffing attack across
  many IPs would bypass it. ~7 attempts/min/IP is generous.
- **No failed-login tracking.** No column on `users` for
  `failed_login_count` / `locked_until`. Login route at
  `auth.ts:120` does only `bcrypt.compare` + 401.
- **Email verification not enforced.** Schema has
  `users.email_verified DEFAULT false` + `email_verify_token`.
  No route writes/reads them; `login` doesn't gate on
  `email_verified=true`. Anyone can register with a fake email
  and use the account immediately.
- **2FA not in codebase** (DEFERRED already flags).

### Notable — frontend token storage

All 9 portals store the JWT in `localStorage` (`gam_token` key).
Standard but XSS-exposed: any injected JS reads + exfils the
token. HttpOnly cookies would be safer but require CSRF
protection (a `SameSite=Lax` cookie + double-submit token, or
similar). Worth flagging as a known trade-off rather than a fix
this round.

### Notable — password complexity

`registerSchema.password: z.string().min(8)`. No complexity rules
(uppercase / digits / symbols). Below modern norms (~12 chars +
classes for financial apps) but acceptable for MVP launch.

## Severity-tiered recommendations

### Pre-launch — must do

1. **Fix the `JWT_SECRET || 'gam_dev_secret'` fallback** in
   `routes/auth.ts:269` + `routes/subleaseInvitations.ts:246`.
   One-line each. (See CRITICAL above.)

### Pre-launch — should do

2. **Implement password reset.** Schema is ready; route + email
   template + frontend page needed. Token TTL ~1h, single-use,
   send via Resend's existing pipeline. Estimate: 1 session.

### Post-launch — backlog

3. **Per-account login lockout.** Add `failed_login_count` +
   `locked_until` to `users`; lock after 5 failures, unlock
   after 15 min or password-reset. ~1 session.
4. **Email verification gate at login.** Schema is ready; add the
   verify route + email template + login gate. ~1 session.
5. **2FA (optional).** TOTP via `otplib`, opt-in via the user
   profile page. Estimate: 1–2 sessions including the recovery-
   codes UI.
6. **Tighter rate-limit on `/login` specifically.** Stack a
   per-IP rate-limit-on-401 pattern on top of the global auth
   limit. Cheaper than full lockout, useful in conjunction.
7. **Password complexity bump** — 12 chars + classes. Cosmetic
   fix but the kind of thing security-conscious users notice.

### Decision items (no recommendation; needs your call)

- **JWT in localStorage vs HttpOnly cookies.** Trade-off
  documented in this report. Cookies are safer against XSS but
  expensive to migrate (every frontend, plus CSRF protection).
- **JWT TTL.** 7d is generous for a financial product; many
  banks use 1h access + 30d refresh with explicit refresh-token
  rotation. Trade-off is UX (more frequent re-logins) vs blast
  radius (shorter token validity).

## Files touched (S277)

```
SESSION_277_HANDOFF.md            (this file — no code changes)
```

DEFERRED.md not updated this session — the auth items aren't
"shipped" per the audit; the gaps need product calls and
session-sized follow-ups.

## Carry-forward — S278+

### High-leverage launch items I can drive

1. **Fix the JWT_SECRET fallback** (5 min, one-line × 2). Trivial
   fix once you OK it.
2. **Implement password reset.** Schema ready, ~1 session.
3. **Email verification gate at login.** Schema ready, ~1 session.
4. **Per-account login lockout.** Schema change + login route
   tweak, ~1 session.

### Other launch list items (DEFERRED order)

- Frontend Sentry rollout (mechanical, no walkthrough = ships
  blind).
- Host pick + deploy config (needs your call: Render / Fly /
  Railway).
- Production cron runner (coupled to host).
- Repo hygiene cleanup (`.s*backup` files, multi-file delete
  needs permission).

### Vendor-blocked (unchanged)

- Checkr Partner credentials pending.
- FlexCredit (CredHub + Esusu) pending.

---

End of S277 handoff.
