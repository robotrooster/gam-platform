# Session 282 — closed (Login rate-limit + password length + decisions doc)

## Theme

Two backend quick-wins to close out the S277 audit's auth
hardening list, plus a `LAUNCH_DECISIONS.md` at repo root —
Nic-friendly framing of every choice he needs to make to take
GAM to launch.

No frontend, no walkthrough.

## Items shipped

### Tighter /login rate limit — `apps/api/src/index.ts`

10 attempts per 15min per IP on `POST /api/auth/login`,
`skipSuccessfulRequests: true` so a user's occasional typo
doesn't burn the quota. Stacks on the existing 100/15min on
`/api/auth/*`. Complements the per-account lockout from S280:
- **S280 lockout** = "this account is being attacked" defense
- **S282 login limiter** = "this IP is attacking many accounts"
  defense

Response on limit: `429 { error: 'Too many login attempts from
this IP. Try again later.' }`.

### Password length 8 → 12 — `apps/api/src/routes/auth.ts`

Three call sites updated:
- `registerSchema.password.min(12)`
- `register-prospect` manual `password.length < 12` check
- `resetPasswordSchema.newPassword.min(12)`

All driven off a new `PASSWORD_MIN_LEN = 12` constant. Comment
on the constant cites NIST SP 800-63B's guidance favoring
length over composition rules (composition pushes users toward
"Password1!"-style predictable patterns).

Test passwords with 11 chars bumped to 12+ where they go
through the schema (`newpass5678` → `newpass45678`). Old-pwd
values in tests stay short — they go through bcrypt directly,
not the schema.

### New doc — `LAUNCH_DECISIONS.md` (repo root)

Product-designer-friendly briefing of every decision Nic needs
to make pre-launch. For each:
- What you're picking
- Why it matters (user/business consequence)
- Options
- Recommendation when there's a clear winner
- What changes downstream after the call

Items covered: host pick (Render recommended), Resend domain,
Stripe live keys, frontend auth pages, 2FA yes/no (recommend
skip for launch), legal docs, vendor go-lives, repo hygiene,
frontend Sentry rollout, suggested launch sequence.

Lives at repo root. Updates as decisions land.

### Memory — user profile

Saved a user-type memory: Nic is a product designer (not
technical). Decisions should be framed in product/UX/business
terms with explicit recommendations, not raw technical menus.
File: `memory/user_product_designer_framing.md`. Future Claude
sessions read this via MEMORY.md.

## Decisions made during build

| Question | Decision |
|---|---|
| Length-only vs length + composition for password bump | **Length only.** NIST SP 800-63B explicitly recommends against composition rules — they push users toward predictable patterns without meaningfully raising attacker cost. 12 chars + no composition is more secure AND simpler UX than 8 + classes. |
| Should the login limiter count successes? | **No — `skipSuccessfulRequests:true`.** A user who occasionally typos their password shouldn't get rate-limited after a normal day of use. The point is to catch attackers, not punish legitimate fumblers. |
| Login limit threshold | **10/15min.** Allows ~40 attempts/hour from one IP, which is plenty for a real user retrying; way below what a credential-stuffing attack would generate. Combined with the per-account lockout (5 fails locks the account), 10/15min on the IP side is the right balance. |
| Should the decisions doc be a session handoff, a one-off audit, or a living doc? | **Living doc at repo root.** Nic comes back to it as decisions land; future Claude sessions reference it. Calling it `LAUNCH_DECISIONS.md` instead of a session handoff signals "this is for the operator, not for the next AI session." |
| Memory: is the "product designer not technical" thing user/feedback/project? | **User.** It's about who he is, which informs how to communicate in every future conversation. Not a one-off feedback note. |

## Files touched (S282)

```
apps/api/src/index.ts                     (~ +10 lines — loginLimiter)
apps/api/src/routes/auth.ts               (~ PASSWORD_MIN_LEN constant +
                                            3 update sites)
apps/api/src/routes/passwordReset.test.ts (~ newpass5678 → newpass45678;
                                            assertion text updated)
LAUNCH_DECISIONS.md                       (new — Nic-facing decisions
                                            briefing, ~280 lines)
DEFERRED.md                               (~ login-limiter + password-
                                            length tombstoned)
memory/MEMORY.md +
memory/user_product_designer_framing.md   (Nic's role profile for
                                            future sessions)
SESSION_282_HANDOFF.md                    (this file)
```

## Verification

- `cd apps/api && npm test` → 107/107 passing across 9 suites.
- `cd apps/api && npx tsc -b` → clean.
- `cd apps/pos && npm test` → 15/15 unchanged.
- Repo total: **122 passing**.

## Carry-forward — S283+

Backend hardening has effectively hit completion. The S277 audit
items remaining are either:
- Decision-gated (2FA, complexity classes — see LAUNCH_DECISIONS)
- Out of scope for MVP (verify-email-change flow,
  email_verified_at audit column)

What's next is **almost entirely Nic's calls** —
`LAUNCH_DECISIONS.md` lays them out in order. Recommended
sequence at the bottom of that file.

### What Claude can drive without input

Mostly background work + diminishing-returns tests:
- console.* migration on hot paths (350 sites total; webhook +
  allocation + cron jobs are the load-bearing 50)
- Lease lifecycle session-2 deferrals (utility line items,
  sublease branch, accrual ticks, cron registration smoke)
- account.updated webhook test
- email_verified_at audit column

### What's blocked on Nic

Per `LAUNCH_DECISIONS.md`:
- Host pick (Render recommended) → unlocks deploy + cron + DB
  backups (~1 session of Claude work after pick)
- Resend domain (just need the domain name)
- Stripe live keys (config flip, do last)
- Frontend pages for auth (1 walkthrough session)
- Frontend Sentry rollout (mechanical, no walkthrough needed)
- 2FA yes/no (recommend skip for launch)
- Legal docs (lawyer's timeline + 1 session post-text-lock)
- Repo hygiene cleanup (5 min, permission only)

### Vendor-blocked (unchanged)

- Checkr Partner credentials (Monday per DEFERRED).
- FlexCredit (CredHub + Esusu) pending.

---

End of S282 handoff.
