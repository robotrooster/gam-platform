# Session 281 — closed (Email verification — backend)

## Theme

Acts on the S277 audit's "email_verified column exists, never
enforced" finding. Adds the missing verification flow + gates
/login on it. Existing `users.email_verified` (bool) and
`users.email_verify_token` (text) columns are now load-bearing.

No frontend, no walkthrough.

## Items shipped

### New email — `apps/api/src/services/email.ts`

`sendEmailVerification(to, firstName, verifyUrl, ctx?)`. Same
styled `base/h/p/btn` helpers as the other auth emails. Copy says
"doesn't expire, one-time use" (matches the implementation).
`email_send_log` category: `email_verification`.

### Helper — `apps/api/src/routes/auth.ts`

```ts
async function mintAndSendVerifyEmail(userId, email, firstName) {
  const token = crypto.randomBytes(32).toString('hex')
  await UPDATE users SET email_verify_token=token
  void sendEmailVerification(email, firstName, `${VERIFY_EMAIL_URL}?token=…`)
}
```

Single helper shared by register + register-prospect + the
resend-verification route + the login-failed-gate auto-resend.

### Routes — `apps/api/src/routes/auth.ts`

**`POST /api/auth/verify-email`**
- Input: `{ token }`.
- Single-use UPDATE: `SET email_verified=TRUE, email_verify_token=NULL
  WHERE email_verify_token=$1 RETURNING id`. Replay matches no row.
- Returns `200 { message: "Email verified. You can now sign in." }`
  on success, `400 "Verification link is invalid or already used"`
  on no-match.

**`POST /api/auth/resend-verification`**
- Input: `{ email }`.
- Anti-enumeration: identical 200 response regardless of whether
  the email exists OR the account is already verified. Internally:
  known + unverified → mint new token + email; everyone else
  no-ops.

### Register hooks

`/register` and `/register-prospect` both call
`mintAndSendVerifyEmail` post-commit. Fire-and-forget — email
failure doesn't fail registration. User can request a resend.
Register still issues a JWT for the just-registered session (soft
gate).

### Login gate — `apps/api/src/routes/auth.ts`

Verification check runs **AFTER** bcrypt.compare and the
counter-reset UPDATE:
- Wrong password + unverified → generic 401 "Invalid credentials".
  No leak that the account exists.
- Right password + unverified → 401 "Please verify your email. A
  new verification link was just sent." Auto-fires a fresh email.
- Right password + verified → 200 + JWT (existing path).

### Test seed helpers — `apps/api/src/test/dbHelpers.ts`

`seedLandlord`, `seedManager`, `seedTenant` all now insert with
`email_verified=TRUE`. The two existing test files that bypass
those helpers (`passwordReset.test.ts` `seedUserWithPassword`,
`loginLockout.test.ts` `seedUser`) updated similarly. Otherwise
the new login gate would lock the entire prior suite out.

### Env var — `.env.example`

```
# VERIFY_EMAIL_URL=https://tenant.gam.example.com/verify-email
```

Defaults to `http://localhost:3002/verify-email` (tenant portal)
when unset.

### Test suite — `apps/api/src/routes/emailVerification.test.ts`

12 cases. All passing.

**Register side effect (1)**
| # | Case | What it pins |
|---|---|---|
| 1 | POST /register | token written + email fired post-commit (polled — fire-and-forget) |

**verify-email (4)**
| # | Case | What it pins |
|---|---|---|
| 2 | Valid token | email_verified=true, token cleared |
| 3 | Invalid token | 400 |
| 4 | Replay (single-use) | second attempt 400 |
| 5 | Missing token | 400 (zod) |

**resend-verification (4)**
| # | Case | What it pins |
|---|---|---|
| 6 | Known unverified | 200, new token rotated, email fires |
| 7 | Known but already verified | 200, no-op (no email, no token change) |
| 8 | Unknown email | 200 (no enumeration), no email |
| 9 | Invalid email format | 400 (zod) |

**Login gate (3)**
| # | Case | What it pins |
|---|---|---|
| 10 | Unverified + correct password | 401 "please verify", new email auto-fires |
| 11 | Unverified + wrong password | 401 "Invalid credentials", no email leak |
| 12 | Verified + correct password | 200 + JWT |

## Decisions made during build

| Question | Decision |
|---|---|
| Hard gate (no JWT on register) or soft (issue JWT, gate /login) | **Soft.** Register still issues a 7d JWT for the just-registered session — preserves the "sign up + immediately use the product" UX everyone expects. Logging back in requires verification, which catches scenarios where the user closed the tab, returned later, and needs proof of email control. Tighter gating (no JWT until verified) is a future option; flagged in the carry-forward. |
| Token TTL | **No TTL.** Different posture from password reset (1h TTL). The security model for verification is "prove email control once"; a 3-week-old email that finally got dug out of spam should still verify. Single-use prevents replay if the email leaks. |
| Verification gate before or after bcrypt | **After.** Putting it before would distinguish "unverified" responses from "wrong password" responses for known emails — useful for the user but leaks "this email is registered" to attackers. After bcrypt: wrong password → generic 401, correct password → verification message. The user always learns enough to make progress; the attacker doesn't. |
| Auto-resend verification email on failed-verify login | **Yes.** Common UX miss: user gets verification email, ignores it, returns later, can't log in, doesn't remember where the email went. Auto-resending makes recovery one-click instead of "find the resend button". |
| Backfill existing users to email_verified=true | **N/A** (no production users yet). Test seed helpers updated so the prior suites' users default to verified. Pre-launch state is "no real users yet" per Nic memory — backfill is a future migration when the time comes. |
| Single helper for mint+send | **Yes.** Four call sites (register, register-prospect, login-failed-gate, resend-verification) all do the same thing: generate a token, write it, fire the email. DRY. |
| Fire-and-forget email | **Yes.** Matches the password-reset pattern. Email failure shouldn't fail registration/login; `email_send_log` captures failures for ops surfacing. |

## Files touched (S281)

```
apps/api/src/services/email.ts                  (~ +25 lines —
                                                  sendEmailVerification)
apps/api/src/routes/auth.ts                     (~ +95 lines —
                                                  mintAndSendVerifyEmail
                                                  helper, 2 routes,
                                                  register hook x2,
                                                  login gate)
apps/api/src/test/dbHelpers.ts                  (~ seedLandlord/
                                                  Manager/Tenant set
                                                  email_verified=TRUE)
apps/api/src/routes/passwordReset.test.ts       (~ seedUserWithPassword
                                                  sets email_verified)
apps/api/src/routes/loginLockout.test.ts        (~ same)
apps/api/src/routes/emailVerification.test.ts   (new — 240 lines, 12
                                                  cases)
.env.example                                    (~ +4 lines — VERIFY_EMAIL_URL)
DEFERRED.md                                     (~ email-verification
                                                  tombstoned)
SESSION_281_HANDOFF.md                          (this file)
```

## Verification

- `cd apps/api && npm test` → 107/107 passing across 9 suites. 47s
  test time, 58s including setup.
- `cd apps/api && npx tsc -b` → clean.
- `cd apps/pos && npm test` → 15/15 unchanged.
- Repo total: **122 passing**.

## Carry-forward — S282+

### Frontend pages (when ready for walkthrough)

- `/verify-email` route — reads token from URL, POSTs to
  `/api/auth/verify-email`, surfaces success/error.
- `/resend-verification` form on the login page (small "didn't get
  the email?" link).
- Reset-password form (from S279 carry-forward).
  All three in one walkthrough session.

### Future tightening (post-launch)

- **Strict gate**: register doesn't issue a JWT until verified.
  Heavier UX hit; defer until use-case forces it.
- **email_verified_at** column for audit trail.
- **Verify-email-change flow** when users edit their email
  post-signup (currently `PATCH /api/auth/me` doesn't touch
  email).

### S277 audit remaining items

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

End of S281 handoff.
