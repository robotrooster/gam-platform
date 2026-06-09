# Session 279 — closed (Password reset — backend)

## Theme

Implements the S277 audit's "should-do" pre-launch item. Schema
columns existed but no route touched them; this session wires the
two-endpoint reset flow + email template + tests. Frontend page
deferred to a later walkthrough session.

No frontend, no walkthrough.

## Items shipped

### New email — `apps/api/src/services/email.ts`

`sendPasswordResetEmail(to, firstName, resetUrl, ctx?)`. Uses the
existing styled `base/h/p/btn` helpers. Brand-consistent. Says
"link expires in 1 hour" + "this link only works once" + "if you
didn't request this, ignore". `email_send_log` category:
`password_reset`.

### New routes — `apps/api/src/routes/auth.ts`

**`POST /api/auth/forgot-password`**
- Input: `{ email }` (zod).
- Always returns `200 { message: "If an account exists for that
  email, a reset link has been sent." }` regardless of whether the
  email exists. Same response shape — no account enumeration.
- If user found: mints `crypto.randomBytes(32).toString('hex')`
  (64-char URL-safe token), persists with `reset_token_expires =
  NOW() + 1 hour`, fires email (fire-and-forget — Resend failures
  go to `email_send_log`, not to the caller).
- Reset URL: `${RESET_PASSWORD_URL}?token=...`. Env var defaults
  to `http://localhost:3002/reset-password` (tenant portal).

**`POST /api/auth/reset-password`**
- Input: `{ token, newPassword }` (zod, `newPassword.min(8)`).
- Lookup by `reset_token = $1 AND reset_token_expires > NOW()`.
- Invalid/expired → `400 "Reset link is invalid or expired"`.
- On success: bcrypt-hashes `newPassword`, clears the token
  fields in the same `UPDATE`. Single-use enforced by the
  same-statement clear (a concurrent replay sees a NULL token
  and 400s).
- Does **NOT** auto-sign-in. Forces fresh `/login` so the user
  proves they remember the new password.

Both routes covered by the existing `authLimiter` (100 req/15min
on `/api/auth/*`).

### Test suite — `apps/api/src/routes/passwordReset.test.ts`

9 cases. All passing.

| # | Case | What it pins |
|---|---|---|
| 1 | forgot known email | 200, 64-char hex token stored, email sender invoked with right args |
| 2 | forgot unknown email | 200 (identical response), no token, no email |
| 3 | forgot invalid email format | 400 (zod) |
| 4 | reset happy | 200, token cleared, password_hash updated |
| 5 | reset invalid token | 400 |
| 6 | reset expired token (backdated `reset_token_expires`) | 400 |
| 7 | reset single-use (replay) | second attempt 400 |
| 8 | reset password too short | 400, token NOT consumed (validation before UPDATE) |
| 9 | end-to-end: old password rejected, new password works on /login | 401 on stale, 200 on fresh |

### Errorhandler — ZodError → 400

While writing the test for case 8 ("password too short → 400"),
caught that `errorHandler` was surfacing `ZodError` as 500. Every
route in apps/api that uses zod's `.parse()` (which is most of
them) was returning 500 on bad input. Captured as a fix-it-right
bonus.

`apps/api/src/middleware/errorHandler.ts` now detects `ZodError`
specifically and returns `400 { success: false, error: <field
summary>, issues: [...zod issues] }`. The summary is `"<path>:
<message>"` for the first issue; the full `issues` array is
included for callers that want field-level surfacing.

This was a real product bug — clients hitting any zod-validated
endpoint with bad input got a generic 500 + Sentry alert + no
useful response. Fixed in one place; every existing route
benefits.

### Env var — `.env.example`

```
# RESET_PASSWORD_URL=https://tenant.gam.example.com/reset-password
```

Commented out (no default needed in dev). Set per-environment in
staging/prod. Comment explains the form is portal-agnostic — any
URL works; pick what users expect to land on (tenant portal
typical).

## Decisions made during build

| Question | Decision |
|---|---|
| Return 200 vs 404 for unknown email on forgot-password | **200, identical to known.** Standard anti-enumeration pattern; 404 leaks "this email has an account" to anyone running a script. |
| Token length / format | **32 bytes (256 bits) hex → 64 chars.** Cryptographically random via `crypto.randomBytes`. Larger than the standard 16-byte UUID; cheap to over-provision. |
| Token TTL | **1 hour.** Long enough for a normal "click the link from email" flow; short enough that a compromised mailbox or stale forwarded email doesn't grant long-running access. |
| Auto-sign-in after reset | **No.** Forces the user to log in with the new password. Confirms they remember it (not just received the email); also makes the audit trail clearer ("login event after reset = user is back in"). |
| Fire email synchronously or fire-and-forget | **Fire-and-forget.** Don't let Resend latency bound the response time on the unauthenticated endpoint; don't surface email failures to the caller (also anti-enumeration — different timing/error shape per branch leaks). `email_send_log` captures failures for ops. |
| Single-use enforcement | **Via the UPDATE that consumes the token.** Same statement clears `reset_token` + sets new `password_hash`. Concurrent replay sees `reset_token=NULL` on lookup → 400. No advisory lock needed; the UPDATE's row-lock is enough. |
| ZodError fix scope | **In errorHandler, not per-route.** One-place fix covers every zod-using route in the codebase. The alternative (try/catch in each route) is hundreds of changes for the same result. |
| New password complexity rules | **Just `min(8)`, matching `registerSchema`.** A stricter complexity gate is a separate decision (S277 flagged as backlog). Consistency over creep. |

## Files touched (S279)

```
apps/api/src/services/email.ts                  (~ +30 lines —
                                                  sendPasswordResetEmail)
apps/api/src/routes/auth.ts                     (~ +85 lines — two
                                                  routes + crypto import)
apps/api/src/middleware/errorHandler.ts         (~ +14 lines — ZodError
                                                  → 400 branch)
apps/api/src/routes/passwordReset.test.ts       (new — 245 lines,
                                                  9 cases)
.env.example                                    (~ +5 lines —
                                                  RESET_PASSWORD_URL doc)
DEFERRED.md                                     (~ Password reset
                                                  tombstoned)
SESSION_279_HANDOFF.md                          (this file)
```

## Verification

- `cd apps/api && npm test` → 86/86 passing
  (16 allocation + 14 deposit-return + 18 webhook + 21 leaseLifecycle
  + 8 achRetry + 9 passwordReset). 29s test time.
- `cd apps/api && npx tsc -b` → clean.
- `cd apps/pos && npm test` → 15/15 unchanged.

## Carry-forward — S280+

### Frontend page (next walkthrough session)

When you're ready for a walkthrough: build the reset form at
`/reset-password` in one or more portals. Reads `token` from
URL query, POSTs `{ token, newPassword }` to
`/api/auth/reset-password`, surfaces success/error. Pairs with a
"Forgot password?" link on the login page that POSTs to
`/api/auth/forgot-password`. ~1 session including styling.

### S277 audit remaining items

Backlog from the audit, all backend-doable:
- **Per-account login lockout** (`failed_login_count` +
  `locked_until` columns + login-route gate). ~1 session.
- **Email verification gate at login** (column exists, just
  enforce). ~1 session.
- **Boot-time JWT_SECRET validation** (~2 lines in instrument.ts).
- **Tighter rate-limit on /login** specifically.
- **2FA.** Optional, 1–2 sessions.
- **Password complexity bump** (8 → 12 + classes).

### Launch list — needs your call

- Frontend Sentry rollout.
- Host pick + deploy config.
- Production cron runner (coupled to host).
- Repo hygiene cleanup.

### Vendor-blocked (unchanged)

- Checkr Partner credentials pending.
- FlexCredit (CredHub + Esusu) pending.

---

End of S279 handoff.
