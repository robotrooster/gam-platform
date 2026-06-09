# Session 280 — closed (Login lockout + boot-time env validation)

## Theme

Two of the S277 audit's backlog items, bundled. Credential-
stuffing defense (per-account lockout, complements the per-IP
rate limit that distributed attacks bypass) + a boot-time
fail-fast for missing required env vars.

No frontend, no walkthrough.

## Items shipped

### Migration — `20260514110000_user_login_lockout.sql`

Adds to `users`:
- `failed_login_count int NOT NULL DEFAULT 0`
- `locked_until timestamptz` (nullable)

No backfill — defaults give existing rows the "no failures, not
locked" state.

### Login route — `apps/api/src/routes/auth.ts`

5 fails / 15 min lock. Implementation choices:

- **Gate BEFORE bcrypt.compare.** Even with the right password, a
  locked account stays locked until the window expires. Prevents
  a "try the right password after spam-failing 5x" timing attack
  AND ensures the lockout actually deters credential stuffing
  (otherwise the attacker just gets a brief slowdown).
- **Failure UPDATE bumps + locks in one statement.** The `CASE`
  expression sets `locked_until` only when `failed_login_count +
  1 >= 5`. Concurrent bad-password attempts can't slip past by
  reading a stale count.
- **Success UPDATE resets count + clears `locked_until`.** Keeps
  the row clean over time even when mixing successful + failed
  logins.

```
LOGIN_FAIL_LIMIT = 5
LOGIN_LOCK_MINUTES = 15
```

Lockout cleared by: successful login, password reset, window
expiry (gate compares `locked_until > NOW()`, no sweep cron
needed).

### Password reset — `apps/api/src/routes/auth.ts`

Reset's UPDATE also clears `failed_login_count + locked_until`.
The user proved control of the registered email; that's stronger
evidence than waiting out a 15-min timer.

### New module — `apps/api/src/lib/validateEnv.ts`

`validateEnv()` throws `EnvValidationError` if any required env
var is missing. Currently:
- **Required**: `JWT_SECRET`
- **Optional-but-warned**: `STRIPE_SECRET_KEY`,
  `STRIPE_WEBHOOK_SECRET`, `RESEND_API_KEY`, `DB_PASSWORD`. These
  emit `logger.warn` lines at boot but don't block startup.

### Wired — `apps/api/src/index.ts`

`validateEnv()` called after `dotenv.config()`, before the
express app is built. Misconfigured boots crash with a clear
error instead of silently failing-closed on every request.

### Test suites

`apps/api/src/routes/loginLockout.test.ts` — 7 cases:
| # | Case | What it pins |
|---|---|---|
| 1 | 4 failures | counter at 4, no lock |
| 2 | 5 failures | locks (locked_until ≈ +15 min) |
| 3 | Correct password during lockout | still 401 with "temporarily locked" message |
| 4 | Expired lockout (backdated) | correct password works, counter resets |
| 5 | 3 failures + success | counter resets to 0 |
| 6 | Password reset clears lockout | lockout cleared, new password works immediately |
| 7 | Unknown email | 401, no enumeration, no row to touch |

`apps/api/src/lib/validateEnv.test.ts` — 2 cases:
| # | Case | What it pins |
|---|---|---|
| 1 | JWT_SECRET unset | throws `EnvValidationError` |
| 2 | JWT_SECRET set | no-op |

## Decisions made during build

| Question | Decision |
|---|---|
| Gate before bcrypt or after | **Before.** Else a correct password during lockout would succeed; the whole point is the user has to wait out the timer. |
| Failure UPDATE in one statement vs read-then-write | **One statement.** `CASE WHEN failed_login_count + 1 >= 5 THEN ... END` — atomic. Concurrent attacks can't slip past by racing the gate. |
| 5 / 15 thresholds | **5 fails, 15 min.** Conservative; matches industry conventions (NIST 800-63B suggests 100 wrong-password attempts/lifetime as the upper bound, but 5/15 is the common UX-friendly default). Both are constants at the top of the file; easy to tune later. |
| Where to clear lockout on success | **In the success UPDATE.** Same place we stamp `last_login_at`. One UPDATE per successful login. |
| Password reset clears lockout? | **Yes.** Email control is stronger evidence of identity than waiting out a timer; forcing both is hostile UX and offers no extra security. |
| Lockout cleanup sweep cron? | **No.** The gate compares `locked_until > NOW()`; expired stamps just don't gate. No sweep needed. (`failed_login_count` does stay non-zero after a window expires until the next successful login resets it — visible in the DB but not gating anything.) |
| Validation: hard-fail or warn for missing env | **Hard-fail for `JWT_SECRET`, warn for the rest.** Without JWT_SECRET the API can't verify tokens at all (S277/S278 already removed the hardcoded fallback); booting is pointless. Stripe/Resend missing is degraded but partial functionality (read-only API, e.g.) still works. |
| Should validateEnv be a Sentry-captured exception? | **Throw is enough.** It runs before the Sentry SDK is meaningfully configured, and crashing the process at boot is loud enough — container orchestrator will restart-loop, surfacing the misconfig immediately. |

## Files touched (S280)

```
apps/api/src/db/migrations/
  20260514110000_user_login_lockout.sql        (new — schema add)
apps/api/src/db/schema.sql                     (~ auto-regenerated)
apps/api/src/routes/auth.ts                    (~ +50 lines — lockout
                                                 logic in /login;
                                                 password-reset UPDATE
                                                 also clears lockout)
apps/api/src/lib/validateEnv.ts                (new — boot validator)
apps/api/src/lib/validateEnv.test.ts           (new — 2 cases)
apps/api/src/index.ts                          (~ validateEnv import +
                                                 call before app)
apps/api/src/routes/loginLockout.test.ts       (new — 7 cases, 285 lines)
DEFERRED.md                                    (~ lockout, validateEnv,
                                                 JWT lifecycle items
                                                 tombstoned)
SESSION_280_HANDOFF.md                         (this file)
```

## Verification

- `cd apps/api && npm test` → 95/95 passing across 8 suites. 43s
  test time (lockout suite slow due to multiple bcrypts per test).
- `cd apps/api && npx tsc -b` → clean.
- `cd apps/pos && npm test` → 15/15 unchanged.
- Migration applied locally; schema.sql regenerated.

## Carry-forward — S281+

### S277 audit remaining items

- **Email verification gate at login** (column exists in schema;
  needs verify route + email + login gate). ~1 session.
- **Tighter rate-limit on /login** specifically. ~30 min.
- **2FA.** Optional. 1–2 sessions.
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

End of S280 handoff.
