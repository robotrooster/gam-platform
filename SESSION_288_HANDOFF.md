# Session 288 — closed (2FA backend + Resend split + repo cleanup)

## Theme

First session driven by Nic's pre-launch decisions list. Three
items moved off the "Nic-blocked" list:

- **#8 Repo hygiene** — orphan backup files deleted at repo root
  (`dev.sh.s29c2g.bak`, `package.json.s56.bak`).
- **#2 Resend domain refactor** — `email.ts` now routes through
  two senders (`noreply@goldassetmanagement.com` for system
  messages, `support@goldassetmanagement.com` for invitations +
  adverse-action). DNS records pending Nic's registrar add.
- **#4 2FA (TOTP) backend** — complete: schema migration,
  helper library, four endpoints, login gate, 14 test cases.

Still pending Nic: host pick (#1, dev team), Stripe live keys
(#3, dev team), auth UI frontend (#5), frontend Sentry (#6),
legal docs (#7, drafting together later).

## Items shipped

### Repo hygiene (#8)

Deleted `dev.sh.s29c2g.bak` + `package.json.s56.bak` at repo
root. Route-level `.s19backup` / `.s20backup` files were
already gone from the working tree (git showed them as
deleted but unstaged; the actual disk state was clean). Per
project rules, multi-file deletes required Nic's explicit
sign-off — got it ("yes delete") and acted.

### Two-sender email split (#2 — `apps/api/src/services/email.ts`)

`send()` now takes an optional `from: 'noreply' | 'support'`
defaulting to noreply. Two new env vars:

- `EMAIL_FROM_NOREPLY` — defaults to "GAM <noreply@goldassetmanagement.com>"
- `EMAIL_FROM_SUPPORT` — defaults to "GAM Support <support@goldassetmanagement.com>"

Both fall back to the existing `EMAIL_FROM` for environments
that haven't been split yet, which in turn falls back to the
Resend playground sender for dev.

**Sender routing (7 emails moved to `support`):**

- `emailInvitation` — in-house worker invitation
- `emailPmInvitation` — PM staff invitation
- `emailPmPropertyInvitation` — bidirectional PM/owner handshake
- `emailAdverseActionNotice` — FCRA notice, legally invites a
  response from the data subject
- `sendSubleaseInvite` — sublessee invite
- `sendPosCustomerOnboarding` — FlexCharge tab invite
- `emailTenantOnboarded` — landlord added you to GAM

Everything else (password reset, verification, signing reminders,
late-payment notices, allocation receipts, generic notifications)
stays on `noreply`.

**Action for Nic:** add the domain `goldassetmanagement.com` in
the Resend dashboard. Resend will generate SPF + DKIM + DMARC
records — add them at your registrar. Once Resend marks the
domain verified, set both `EMAIL_FROM_NOREPLY` and
`EMAIL_FROM_SUPPORT` env vars to the production values. Until
then they continue defaulting to whatever `EMAIL_FROM` was set to.

### 2FA TOTP backend (#4)

**Schema migration** — `20260514150000_user_totp_2fa.sql`:

- `users.totp_enabled` boolean NOT NULL DEFAULT FALSE
- `users.totp_secret` text NULL (base32 secret, stored as-is —
  server needs plaintext to verify codes)
- `users.totp_enrolled_at` timestamptz NULL
- New table `user_totp_recovery_codes`: 10 single-use codes
  per user, bcrypt-hashed at rest, with `used_at` for audit
  trail and a partial index on `(user_id) WHERE used_at IS NULL`
  for the verify-time lookup

**Library** — `src/lib/totp.ts`:

- `otplib` v12.0.1 (pinned — v13 has a different API surface;
  v12's `authenticator` namespace is the documented stable API)
- `qrcode` for server-side PNG QR data URI generation
- Exports: `generateTotpSecret`, `otpauthUrlToQrDataUri`,
  `verifyTotpToken`, `generateRecoveryCodes`,
  `hashRecoveryCode`, `verifyRecoveryCode`
- `MANDATORY_TOTP_ROLES` = `{admin, super_admin, admin_ops}` at
  launch — landlord + pm_company moved out per the call
  ("optional-with-prompts now, flip to mandatory after weeks of
  adoption")

**Endpoints** — `src/routes/totp.ts` mounted at `/api/auth/totp`:

- `POST /enroll-start` — generates secret + QR data URI + 10
  recovery codes. Stores secret in `users.totp_secret`, inserts
  10 hashed recovery codes. Recovery codes returned plaintext
  ONCE (frontend's responsibility to display + warn the user
  to save).
- `POST /enroll-confirm` — body `{ token }`. Verifies the
  6-digit token against the stored secret. If valid, flips
  `totp_enabled = TRUE` + stamps `totp_enrolled_at`.
- `POST /disable` — body `{ password }`. Re-confirms password
  (defense vs stolen session). Clears all TOTP state +
  recovery codes.
- `POST /verify` — body `{ totpSession, code }`. Called pre-JWT
  during login. Accepts either a 6-digit TOTP token or a
  recovery code (recovery codes match `^[a-f0-9]{5}-[a-f0-9]{5}$`,
  TOTP tokens match `^\d{6}$`). Recovery codes get marked
  `used_at = NOW()` on successful redemption — single use.

**Login gate** — `src/routes/auth.ts` /login modification:

- If `user.totp_enabled` AFTER password + lockout + verification
  checks pass: mint a short-lived (5-min) `totp_session` JWT
  with `purpose: 'totp_pending'` instead of the full
  session JWT. Response shape: `{ requiresTotp: true,
  totpSession }`.
- Otherwise issue the full JWT as before, with an additional
  `mustEnrollTotp` flag set when `role ∈ MANDATORY_TOTP_ROLES`
  AND `totp_enabled = false`. Frontend uses this to gate
  access to the rest of the app until enrollment completes.

**Defense properties locked in by tests:**

- A regular session JWT cannot be replayed as a `totp_session`
  (`purpose: 'totp_pending'` claim is required).
- A `totp_session` signed against a different secret is rejected
  (jwt.verify throws → 401).
- Recovery codes are single-use (verified by attempting the
  same code twice — second attempt fails).
- Re-enroll while `totp_enabled = TRUE` is refused (409 — must
  disable first).
- Disable without correct password is refused.

**Test surface** — `src/routes/totp.test.ts`, 14 cases covering
enroll-start (happy + re-enroll guard), enroll-confirm (happy +
invalid code + no-start-yet guard), login gating, /verify (TOTP
+ recovery code + invalid + expired session + wrong-purpose
session), disable (wrong password + happy + not-enabled guard).

## Decisions made during build

| Question | Decision |
|---|---|
| `email.ts` API: per-call `from?: 'noreply' \| 'support'` vs separate `sendNoReply()` / `sendSupport()` functions vs context-based routing? | **Per-call param defaulting to noreply.** Backward-compatible with the existing single-`send` API; explicit at each call site; one place to find each sender. Two separate functions would force a wider rewrite at every existing call site even when the default would have been correct. |
| Store TOTP secrets encrypted at rest, or plaintext? | **Plaintext.** Server needs the secret to compute the current token for verification — there's no one-way function that works here the way bcrypt does for passwords. DB-level encryption (e.g., the host's volume encryption) is the right layer for this defense; application-level secret encryption with a key on the same server doesn't change the threat model. |
| Recovery code format — long base32 string vs short hex with hyphen? | **10-char hex with mid-hyphen** (`abc12-de345`). Matches what GitHub / Google / 1Password surface, easy to read off paper, hard to mistype. 10 hex chars = 40 bits of entropy ≈ 1 trillion combinations — fine for a single-use code. |
| TOTP session token shape — DB-backed session ID vs short-lived stateless JWT? | **Stateless JWT** with `purpose: 'totp_pending'` claim and 5-minute TTL. No new table to manage, no garbage collection cron, no DB lookup on verify. The 5-minute TTL is tight enough that an interception window has minimal value. |
| Library — otplib v13 (newest) vs v12 (current stable, `authenticator` namespace)? | **v12.0.1 pinned.** v13 was released as a breaking-change rewrite; the `authenticator.generate/check/keyuri` namespace API in v12 is what every otplib doc / blog / Stack Overflow answer references. v12 has been stable for years; no benefit to v13 for our needs. |
| `mustEnrollTotp` flag client-enforced vs server-enforced? | **Client-enforced for now.** Server-enforced means most route guards refuse requests from a user with `MANDATORY_TOTP_ROLES.has(role) && !totp_enabled`. Doable but adds a check on every request and a "you must enroll" response shape every endpoint has to handle. Client-enforced (frontend redirects to enrollment if `mustEnrollTotp: true`) is the standard pattern and S289 frontend session will wire it. Tighten to server-side after a few weeks of adoption if needed. |
| Adverse-action notice — was that a real "support" candidate or should it stay noreply? | **support.** FCRA explicitly gives the recipient the right to contact the data furnisher about the report. Sending from `noreply` would technically be a compliance flag — recipients need a reply path. Moved. |
| `sendOnTimePayInvitation` — invitation in name, but should it use support? | **noreply.** It's an automated nudge fired by the late-payment-count cron, not a person reaching out. If a recipient replies confused about it, that reply hitting the support inbox makes sense — but the FROM should reflect that it's a system message. |

## Files touched (S288)

```
apps/api/package.json                                  (~ +otplib +qrcode
                                                          +@types/qrcode)
apps/api/src/db/migrations/20260514150000_user_totp_2fa.sql
                                                       (new — schema)
apps/api/src/db/schema.sql                             (auto-regenerated)
apps/api/src/lib/totp.ts                               (new — TOTP helpers,
                                                          ~115 lines)
apps/api/src/routes/totp.ts                            (new — 4 endpoints,
                                                          ~270 lines)
apps/api/src/routes/totp.test.ts                       (new — 14 cases,
                                                          ~310 lines)
apps/api/src/routes/auth.ts                            (~ +25 lines — login
                                                          TOTP gate +
                                                          mustEnrollTotp flag)
apps/api/src/index.ts                                  (~ +2 lines — mount
                                                          totpRouter at
                                                          /api/auth/totp)
apps/api/src/services/email.ts                         (~ +30 lines — two-
                                                          sender refactor,
                                                          7 call sites
                                                          routed to support)
.env.example                                           (~ replaced single
                                                          EMAIL_FROM with
                                                          NOREPLY + SUPPORT
                                                          vars + DNS note)
dev.sh.s29c2g.bak                                      (deleted)
package.json.s56.bak                                   (deleted)
DEFERRED.md                                            (~ 2FA tombstoned;
                                                          repo hygiene
                                                          tombstoned)
SESSION_288_HANDOFF.md                                 (this file)
```

## Verification

- `cd apps/api && npx tsc -b` → clean.
- `cd apps/api && npm test` → **141 / 141 passing** across
  14 suites (was 127 / 13; +14 TOTP cases).
- `cd apps/pos && npm test` → 15 / 15 unchanged.
- Repo total: **156 passing**.
- `psql gam -c "SELECT filename FROM schema_migrations ORDER BY filename DESC LIMIT 1"` →
  `20260514150000_user_totp_2fa.sql` applied to dev DB.

## Carry-forward — S289+

### What S289 / next session should target

1. **2FA frontend** — enrollment + login second-step + recovery
   code display/entry, across admin + admin-ops + landlord +
   PM company portals. Tenant gets an optional flow with a
   "secure your account" banner. ~1 walkthrough session if all
   four portals at once; ~half-session for backend-driving
   portals (admin + admin-ops) alone.

2. **Auth UI frontend (#5 from Nic's list)** — forgot password
   + reset password + verify email pages. Backend has been
   live since S279/S281. Pages don't exist yet — without them,
   the email links go nowhere. ~1 walkthrough session per
   portal (probably do tenant first since that's where signup
   traffic lands).

3. **Frontend Sentry rollout (#6)** — Nic asked for context;
   wait for sign-off. Mechanical once approved: `Sentry.init`
   + `<ErrorBoundary>` in each portal's `main.tsx`. ~1 session
   for all 10 frontends.

### Nic-pending items unchanged

- #1 Host pick — dev team
- #3 Stripe live keys — dev team
- #7 Legal docs — drafting together later, no attorney

### Vendor-blocked (unchanged)

- Checkr Partner credentials (Monday).
- FlexCredit (CredHub + Esusu).

---

End of S288 handoff.
