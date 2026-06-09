# Session 290 — closed (2FA frontend — admin portal)

## Theme

S288 backend (TOTP) ship + S289 carry-forward called for the
frontend half. Admin portal first because it's the smallest
user base AND the role for which 2FA is mandatory at launch
(`MANDATORY_TOTP_ROLES = {admin, super_admin, admin_ops}`).
Validating the full enrollment + login flows on admin sets the
pattern; admin-ops / landlord / PM company portals can copy in
follow-up passes.

Backend change: `/api/auth/me` now returns `totp_enabled` +
`must_enroll_totp` so the auth context survives page refresh
with accurate state.

**Browser smoke not performed in this session.** Per project
rule, Nic walks through.

## Items shipped

### `apps/api/src/routes/auth.ts` — `/me` extended

Added two fields:

- `totp_enabled` (raw from `users.totp_enabled`)
- `must_enroll_totp` — server-computed:
  `MANDATORY_TOTP_ROLES.has(user.role) && !user.totp_enabled`

Server-computing the flag keeps the role-policy single-sourced
in `src/lib/totp.ts`. The camelCase outbound middleware
auto-converts these to `totpEnabled` / `mustEnrollTotp` on the
wire.

### `apps/admin/src/main.tsx` — full 2FA frontend

**`AuthUser` interface** — added `totpEnabled?: boolean` and
`mustEnrollTotp?: boolean`.

**`AuthCtx` interface** — `login()` now returns a discriminated
result (`{ kind: 'success' }` or `{ kind: 'totp_required';
totpSession }`). New `loginWithTotp(totpSession, code)` method
trades the short-lived totp_session JWT for the full session
JWT via `/api/auth/totp/verify`. New `refresh()` method (now
exposed externally) re-fetches `/me` — used by the enrollment
flow to refresh `totpEnabled` / `mustEnrollTotp` after the
backend flips them.

**`AuthProvider`** — implementations of the above. `loginWithTotp`
sets a partial user object from the verify response then calls
`refresh()` to fill in `totpEnabled` / `mustEnrollTotp` from
`/me`. The totp_session JWT is never persisted to localStorage —
it lives only in `LoginPage` component state, so a refresh
mid-flow drops back to step 1.

**`LoginPage`** — multi-step:

- Step 1 (credentials): unchanged shape from before. On
  successful credential POST, if backend returned
  `requiresTotp`, stash the `totpSession` in component state
  and pivot to step 2.
- Step 2 (code): single input that accepts either a 6-digit
  TOTP token (digits, `123 456` formatting works) or a recovery
  code (`xxxxx-xxxxx`). Calls `loginWithTotp`. On a session-
  expired error message from the backend, automatically drops
  back to step 1.

**`TotpEnrollPage`** — full enrollment flow:

- On mount: `POST /api/auth/totp/enroll-start`. Renders QR
  data URI (PNG embedded as `<img src=...>`), 10 recovery
  codes in a 2-column grid, an "I've saved my recovery codes"
  acknowledgement checkbox, and a 6-digit code input.
- 409 on enroll-start (already enrolled) → redirect to
  /overview (covers the edge where a user lands here from a
  bookmark after enrolling elsewhere).
- "Can't scan?" link surfaces the raw `otpauth://` URL for
  authenticator apps that support manual entry.
- Submit disabled until the recovery-codes ack is checked AND
  the code field has at least 6 characters. Prevents the
  "I lost my recovery codes immediately" failure mode.
- On confirm success: `refresh()` updates the auth context,
  brief "Two-factor authentication enabled" state for 700ms,
  then redirect to /overview.

**`MustEnrollTotpGate`** — small wrapper component. If
`user.mustEnrollTotp`, renders `<Navigate to="/totp/enroll"
replace/>`; otherwise renders children. Wrapped around the
authenticated Layout in the routes block.

**`App` routes** — added a `/totp/enroll` route OUTSIDE the
Layout block (since the enrollment-required user can't reach
Layout) but still gated to admin / super_admin roles. The
existing Layout-nested block now passes through
`MustEnrollTotpGate` first.

## Login flow — happy paths after S290

**First-time admin login (mandatory enrollment):**

1. `/login` — enter credentials. Backend returns full JWT with
   `mustEnrollTotp: true`.
2. AuthProvider sets `user` with `mustEnrollTotp: true`.
3. Routes render → Layout would render → `MustEnrollTotpGate`
   intercepts → `<Navigate to="/totp/enroll" />`.
4. `TotpEnrollPage` mounts, calls /enroll-start, shows QR +
   recovery codes + confirm form.
5. User scans, enters first code, ticks the ack, submits.
6. /enroll-confirm succeeds → refresh() pulls fresh /me with
   `totpEnabled: true, mustEnrollTotp: false`.
7. Auto-redirect to /overview. Gate now passes. User reaches
   the admin console.

**Return login (TOTP enabled):**

1. `/login` step 1 — enter credentials. Backend returns
   `{ requiresTotp: true, totpSession }` (no JWT yet).
2. LoginPage pivots to step 2 with the code input.
3. User enters the current 6-digit code (or a recovery code).
4. `loginWithTotp` calls /verify → full JWT.
5. AuthProvider sets user → Layout renders → admin console.

**Lost-phone recovery:**

1. Same as return login, but at step 2 the user enters one of
   their saved recovery codes (`xxxxx-xxxxx` format) instead
   of a TOTP token.
2. Backend marks that recovery code used; subsequent attempts
   with the same code fail.

## Decisions made during build

| Question | Decision |
|---|---|
| Where does the TOTP secondary step live — same page as Login, separate route? | **Same page (LoginPage), local state pivot.** Cleaner from a state-machine standpoint — totp_session lives only in component state, never persisted. A refresh mid-step kicks the user back to credentials, which is the safer posture for a half-completed authentication. A separate /totp-verify route would need to either pass the session via route state (lost on refresh anyway) or sessionStorage (more surface area for a session-fixation-style attack). |
| Force the "I've saved my recovery codes" checkbox before allowing confirm? | **Yes — gate the submit button on it.** This is the one chance the user gets to copy the codes; if they confirm enrollment without saving them and then lose their phone, they're locked out. The friction of a single checkbox is the right tradeoff. |
| Show the recovery codes as plain text on screen vs require a download or copy action? | **Plain text + a checkbox ack.** The user can copy-paste into their password manager directly. A "download as .txt" button is nice-to-have polish but not load-bearing. Pattern matches GitHub / Google. |
| Server-compute `mustEnrollTotp` vs client-compute from role + totp_enabled? | **Server-compute.** Frontend would need its own copy of `MANDATORY_TOTP_ROLES`, which drifts the moment Nic decides to flip landlord / pm_company from optional to mandatory. Server returning the boolean keeps the policy single-sourced in `src/lib/totp.ts`. |
| TotpEnrollPage outside or inside the authenticated Layout? | **Outside.** The Layout has sidebar nav + topbar — if an admin must enroll before reaching the app, they shouldn't see (or be able to click) the nav links. Standalone page mirrors LoginPage's posture. |
| Display the `otpauth://` URL even when QR is showing? | **Hide behind a small "Can't scan?" link.** QR is the common path; manual entry is the fallback for authenticator apps without camera access (rare). Hiding it keeps the primary flow visually focused. |
| Logout button on the enrollment page? | **Yes.** Edge case: an admin who shouldn't have admin role grants accidentally lands on the enrollment page. Logging out is the bail-out. Also useful if Nic gets a flow he wants to escape during the smoke walk. |
| Branding on the second-step screen — "ADMIN CONSOLE" still or something softer? | **Keep "ADMIN CONSOLE".** The user is mid-auth flow on the admin portal; staying visually consistent reduces the "wait did I navigate away" cognitive load. |

## Files touched (S290)

```
apps/api/src/routes/auth.ts        (~ +8 lines — totp_enabled + mustEnrollTotp
                                       on /me)
apps/admin/src/main.tsx            (~ +250 lines — multi-step Login,
                                       TotpEnrollPage, MustEnrollTotpGate,
                                       AuthProvider login/loginWithTotp/refresh)
SESSION_290_HANDOFF.md             (this file)
DEFERRED.md                        (~ 2FA frontend admin tombstoned)
```

## Verification

- `cd apps/admin && npx tsc -b` → clean.
- `cd apps/api && npx tsc -b` → clean.
- `cd apps/api && npm test` → **141 / 141** unchanged (backend
  /me change covered implicitly — no test exercised the field
  set yet; the change is additive).
- `cd apps/pos && npm test` → 15 / 15 unchanged.
- **Browser smoke check: NOT performed.** Walkthrough plan below.

## What Nic should test in the browser

Start dev.sh and visit `http://localhost:3003` (admin portal).

**Mandatory enrollment flow (admin demo user — `admin@gam.dev`):**

1. Sign in with `admin@gam.dev` / `admin1234`. After credentials
   submit, expect a redirect to `/totp/enroll` (not /overview).
2. Page renders: QR code on the left, 10 recovery codes in a
   2-column grid, code input field below.
3. Open Google Authenticator / Authy / 1Password (or whatever
   you use) and scan the QR. Should show "GAM (admin@gam.dev)"
   with a rotating 6-digit code.
4. Try to submit without ticking the "I've saved..." checkbox
   → button stays disabled. Tick it, code still empty → still
   disabled. Type 6 digits → enabled.
5. Enter the current 6-digit code from your app → "Enable
   two-factor" → expect a success state + auto-redirect to
   /overview.
6. Log out, log in again with same credentials. After password
   submit, expect to pivot to "Two-factor authentication"
   screen with code input.
7. Enter the current 6-digit code → admin console.

**Recovery code path:**

8. Log out. Log in with credentials. At the code prompt, enter
   one of your saved recovery codes (`xxxxx-xxxxx` format).
   Expect successful login.
9. Try the same recovery code again on a fresh login. Expect
   "Invalid code" error (single-use enforcement).

**Disable (via API for now — frontend control is a future polish):**

10. Either smoke now and leave 2FA enabled, OR run `psql gam -c
    "UPDATE users SET totp_enabled=FALSE, totp_secret=NULL,
    totp_enrolled_at=NULL WHERE email='admin@gam.dev';
    DELETE FROM user_totp_recovery_codes WHERE user_id IN (SELECT id FROM users WHERE email='admin@gam.dev');"`
    to reset for the next round.

**Punch list candidates:** spacing on the QR + recovery-codes
grid, color contrast on the gold/red accents, focus rings
visibility, mobile breakpoint at <600px (the QR layout will
need adjustment). Capture anything that feels off.

## Carry-forward — S291+

### Other portals — same pattern

The S290 admin pattern transfers directly to:

- **admin-ops** (`apps/admin-ops/src/main.tsx`) — same posture,
  mandatory at launch. ~half-session of mechanical copy.
- **landlord** (`apps/landlord/src/main.tsx`) — optional-with-
  prompts. Should add a "Secure your account" banner on the
  dashboard for `totpEnabled: false` users, plus the
  enrollment flow available from a Profile / Settings page.
  No mandatory gate. ~1 session including the banner.
- **PM company** (`apps/pm-company/src/main.tsx`) — same as
  landlord (optional-with-prompts). ~half-session.
- **tenant** (`apps/tenant/src/main.tsx`) — fully optional, no
  banner. Just an "Enable two-factor" link buried in Profile.
  Lowest priority. ~half-session.

### Frontend disable flow

Currently disabling TOTP requires a direct backend call
(`/api/auth/totp/disable` with password re-confirm). A
"Disable two-factor" UI in a settings page would round out the
flow but isn't load-bearing for launch — the API endpoint is
there if Nic needs to walk an admin through disable manually.

### Nic-pending items unchanged

- #1 Host pick — dev team
- #2 Resend domain — DNS records pending at registrar
- #3 Stripe live keys — dev team
- #6 Frontend Sentry — awaiting yes/no
- #7 Legal docs — drafting together later

### Vendor-blocked (unchanged)

- Checkr Partner credentials (Monday).
- FlexCredit (CredHub + Esusu).

---

End of S290 handoff.
