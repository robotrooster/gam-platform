# Session 278 — closed (JWT_SECRET hardcoded-fallback fix)

## Theme

Acts on the S277 audit's CRITICAL finding. Two public token-
issuing routes had a `process.env.JWT_SECRET || 'gam_dev_secret'`
fallback. The literal string was repo-committed; if JWT_SECRET
were ever unset in prod (env-var typo, deploy misconfig), an
attacker with repo access could forge valid 7-day tokens for any
userId on those endpoints.

Tiny session — two one-line fixes + a code comment each.

No frontend, no walkthrough.

## Items shipped

### Fix — `apps/api/src/routes/auth.ts:268`

`register-prospect` (public tenant signup from listings).

```diff
- process.env.JWT_SECRET || 'gam_dev_secret',
+ process.env.JWT_SECRET!,
```

### Fix — `apps/api/src/routes/subleaseInvitations.ts:246`

Sublease invitation accept (mints a tenant token on first login).

```diff
- process.env.JWT_SECRET || 'gam_dev_secret',
+ process.env.JWT_SECRET!,
```

Both now match the rest of the codebase — `JWT_SECRET!` fails
closed if the env var is unset.

Code comments at each site point back to S277 for context (rather
than a generic "removed fallback" comment that rots).

## Decisions made during build

| Question | Decision |
|---|---|
| `JWT_SECRET!` vs throw-explicit-then-sign | **Non-null assertion.** Matches the pattern at `auth.ts:72` (login + register) and `middleware/auth.ts:33` (verify). One consistent style across the codebase is more important than the marginal clarity gain of a manual throw. |
| Should the secret be validated at boot too? | Captured for follow-up. A startup-time `if (!process.env.JWT_SECRET) throw` in `instrument.ts` or `index.ts` would fail-fast on misconfig BEFORE any request lands. ~2 lines, but it's its own decision; deferred. |

## Files touched (S278)

```
apps/api/src/routes/auth.ts                 (~ 1-line + comment)
apps/api/src/routes/subleaseInvitations.ts  (~ 1-line + comment)
SESSION_278_HANDOFF.md                      (this file)
```

## Verification

- `cd apps/api && npx tsc -b` → clean.
- `cd apps/api && npm test` → 77/77 passing.
- `grep -r 'gam_dev_secret' apps/api/src` → only the S277 comment
  references remain; no live fallbacks.

## Carry-forward — S279+

The S277 audit's remaining recommendations:

### Pre-launch — should do

- **Implement password reset.** Schema is ready
  (`users.reset_token` + `reset_token_expires`); needs route +
  email template + frontend page. ~1 session.

### Post-launch — backlog

- **Per-account login lockout** (failed_login_count + locked_until
  columns + login-route gate). ~1 session.
- **Email verification gate at login** (column exists, just
  enforce). ~1 session.
- **Boot-time JWT_SECRET validation** (~2 lines in instrument.ts
  or index.ts).
- **Tighter rate-limit on /login specifically.**
- **2FA.** Optional. 1–2 sessions.
- **Password complexity bump** (8 → 12 + classes).

### Launch list — needs your call

- Frontend Sentry rollout (mechanical, no FE test coverage).
- Host pick + deploy config (Render / Fly / Railway).
- Production cron runner (coupled to host).
- Repo hygiene cleanup (`.s*backup` files, multi-file delete).

### Vendor-blocked (unchanged)

- Checkr Partner credentials pending.
- FlexCredit (CredHub + Esusu) pending.

---

End of S278 handoff.
