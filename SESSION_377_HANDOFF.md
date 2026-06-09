# Session 377 — closed

## Theme

tenants.ts arc continues. **Slice 4 of N:** invite +
accept-invite + invite-info (3 routes — the entire public
tenant-onboarding flow).

The slice surfaced **2 production-breaking bugs** that
*together* meant tenant invite/onboarding has been
completely non-functional for some time. Both fixed in the
same pass per the fix-it-right rule. The router-level
`requireAuth` was masking the bcryptjs typo — fixing one
exposed the other.

15 new test cases pin the slice + verify the fixes.

Suite at S376 close: **1124 / 65 files**.
Suite at S377 close: **1139 / 66 files** (+15 cases, +1 file).
Runtime ~624s.

Zero tsc regressions, zero production regressions.

## Bugs found + fixed

### Bug 1 — `requireAuth` gated the public invite endpoints

**Symptom:** `tenantsRouter.use(requireAuth)` at the top of
`tenants.ts` applies to every route on the router, including
`/accept-invite` and `/invite-info`. A tenant clicking an
email invite link has no JWT yet (their account isn't
activated). The frontend `apiGet`/`apiPost` in
`apps/tenant/src/lib/api.ts:9` reads the JWT from
localStorage; on the invite landing page that storage is
empty, so the Authorization header isn't set. Result: both
endpoints return 401, and tenant onboarding never completes.

The route's own comment at the original line 951 even said
"get invite details without auth" — the public intent was on
the record. The `tenantsRouter.use(requireAuth)` was added
later and silently broke the contract.

**Fix:** moved both routes ABOVE the
`tenantsRouter.use(requireAuth)` line. Express middleware
applies in declaration order on a router; routes declared
before `.use(mw)` aren't gated by it. Added a header
comment explaining the ordering.

```
tenants.ts:14   export const tenantsRouter = Router()
tenants.ts:16   // ── PRE-AUTH PUBLIC ROUTES ────────────────────
tenants.ts:24   tenantsRouter.post('/accept-invite', ...)
tenants.ts:119  tenantsRouter.get('/invite-info', ...)
tenants.ts:143  tenantsRouter.use(requireAuth)
```

### Bug 2 — `require('bcrypt')` would crash at runtime

**Symptom:** Inside `/accept-invite`, line 867 of the original
file used `require('bcrypt')`. The package isn't installed —
`apps/api/package.json` only has `bcryptjs` (which the rest of
the codebase uses: auth.ts, scopes.ts, totp.ts, books.ts,
seed.ts, subleaseInvitations.ts, and even line 1191 of the
same tenants.ts file). The lone `'bcrypt'` typo would have
thrown `Cannot find module 'bcrypt'` and returned 500 on
every accept-invite attempt.

This bug was **hidden by bug 1**. The `requireAuth` gate
returned 401 before the route body ran, so the missing-module
crash was never observed in any prior test or manual smoke.
Fixing bug 1 immediately exposed bug 2 — the new test for the
happy path returned 500, which led to the typo.

**Fix:** one-character change, `'bcrypt'` → `'bcryptjs'`.

Both fixes confirmed by the new test suite (5/15 originally
failing → 13/15 after bug 1 fix → 15/15 after bug 2 fix).

## Items shipped

### Test coverage — 15 cases / 3 describe blocks

New file: `apps/api/src/routes/tenants-invite.test.ts` (310 lines)

**POST /invite — landlord invites tenant (5 cases)**
- missing email/firstName/unitId → 400 (4 body shapes
  iterated; all 400 with "required")
- unit not found (unknown uuid) → 404
- cross-landlord forbidden → 403 (landlord A targeting
  landlord B's unit hits `canAccessLandlordResource` deny)
- happy: creates user + tenant rows; returns 64-char hex
  inviteToken; acceptUrl uses TENANT_APP_URL env;
  email_verify_token is stamped on users
- re-invite same email reuses existing user row (no duplicate)

**POST /accept-invite — tenant activates (7 cases)**
- missing token → 400
- missing password → 400
- password < 8 chars → 400
- acceptedTerms !== true → 400
- invalid token (non-existent) → 404
- happy: bcrypt-hashes password (envelope `^\$2[aby]\$`),
  clears email_verify_token, flips email_verified=TRUE,
  stamps accepted_tos_at + accepted_privacy_at,
  COALESCE-updates phone, returns 7-day JWT bound to the
  correct user + profileId + tenant role
- happy with ssiSsdi=true: flips tenants.ssi_ssdi flag

**GET /invite-info — unauthenticated preview (3 cases)**
- missing token → 400 "Token required"
- invalid token → 404 "Invalid or expired"
- happy without active lease: returns user details +
  unit=null (no lease yet means the join finds no row)

### Test infra

- 2 service mocks: `notifyTenantInviteAccepted` +
  `getPropertyResponsibleParty` (vi.hoisted). Both default
  to no-op so the accept-invite notify side path can fail
  silently the way it does in production without polluting
  test logs.

## Files touched

```
apps/api/src/routes/
  tenants.ts                (MODIFIED — 2 production bug fixes:
                             route reorder + bcryptjs typo)
  tenants-invite.test.ts    (NEW — 310 lines, 15 cases)
```

No migrations. No schema changes. No frontend touched.

## Decisions made during build

| Question | Decision |
|---|---|
| Move /accept-invite + /invite-info above `use(requireAuth)`, OR split into a separate router, OR refactor to per-route requireAuth? | **Move above.** Cleanest minimal fix: ~135 lines moved within the same file. Splitting routers would force a second mount in `index.ts` and split the tenant-route file across two exports. Per-route requireAuth refactor would touch all 38 routes — large diff for no behavioral gain. Express middleware ordering on the same router is idiomatic and well-understood. |
| Fix the bcryptjs typo in the same pass, or flag and defer? | **Fix in pass.** Per fix-it-right rule: we touched this file's surface, the bug was directly exposed by the bug-1 fix, and the fix is one character. Deferring would mean leaving the route 500-broken and writing a test that asserts the wrong behavior. |
| Test that the response of /invite does NOT contain inviteToken (security hardening)? | **No — out of scope.** The route DOES return the inviteToken to the landlord caller; that's the current contract. Whether returning it (vs. only logging or only emailing) is the right product call is a separate question — flagged in "Architectural concerns" below. I tested the contract as it stands; security-hardening on the response shape is a separate slice. |
| Test the 4 missing-field 400s as 4 separate `it()` calls or one iterated case? | **One iterated `it()`.** Same validation gate, same error message — 4 separate test cases for the same `if (!email \|\| !firstName \|\| !unitId)` branch would be ceremony. Iteration covers the matrix without inflating test count for accounting purposes. |
| Include a test for the BCrypt-envelope shape on the password hash? | **Yes — single assertion.** `/^\$2[aby]\$/` confirms bcrypt's standard envelope; a hex regex would have passed even if password storage degraded to MD5. Cheap signal worth keeping. |
| Test the email_verify_token column collision with the auth.ts email-verification flow? | **No — out of scope.** The collision risk (same column reused across 3 flows: tenant invite, landlord invite, email verification) is real but requires schema or routing changes to fix. Flagged in "Architectural concerns" — not in-scope for a test slice that pins the current contract. |

## Architectural concerns flagged (not fixed)

These were observed during recon but are out of scope for
the test slice. None are fix-it-right candidates because they
require product or schema decisions, not isolated fixes.

### A. Invite token leakage surface

`/invite` returns the raw `inviteToken` in the API response
body (line 849 of pre-edit; line 67 of new top block) AND
logs the full accept URL with the token at logger.info level
(line 841). The token is the password-bypass mechanism for
the invited tenant account. Today this is acceptable because
pre-launch there's no email dispatch wired and the landlord
manually copy-pastes the URL to the tenant. Once email
dispatch lands, the token should never appear in:
- API responses
- Application logs
- Error tracking

This is a Nic-pending question for whenever invite-email
dispatch gets wired.

### B. `email_verify_token` column is overloaded across 3 flows

The single `users.email_verify_token` column is used as the
auth-bypass token for:
1. Tenant invite (tenants.ts:48 of new top block — sets it
   on landlord-initiated invite)
2. Landlord/PM invite (landlords.ts:836 + :2581)
3. Email verification (auth.ts:515 — mints + clears for
   self-signup email confirmation)

If a user (rare but possible) is invited AND triggers
resend-verification on the same email, each flow overwrites
the other's token. The semantic intent of each flow is
different but they share storage. Plausible mitigations:
- Separate columns (`email_verify_token` for self-signup;
  `invite_token` for landlord/PM-issued)
- Token-type discriminator column
- Composite lookup (token + expected flow context)

Not a bug today (the flows are mutually exclusive in normal
use), but a structural concern that would surface as a hard-
to-reproduce "my invite link stopped working" support ticket.

### C. Invite tokens never expire

The accept-invite path looks up `email_verify_token=$1` with
no expiry check. A pending invite from any past date stays
valid until accepted or until another flow overwrites the
column. The auth.ts email-verification comment at line
505-508 makes the same intentional choice for verification
emails ("emails can sit in spam folder for days"). The
calculus might be different for invite tokens — an
abandoned-then-resurrected invite could re-enable an old
landlord-tenant relationship in unexpected ways. Worth a
product call.

## Verification

- `npx tsc --noEmit` clean on apps/api (0 errors).
- `npm test` in apps/api: **1139 tests across 66 files, 0
  failures**, 623.96s.
- 15 new test cases (`tenants-invite.test.ts`).
- **2 production bug fixes** (tenants.ts route reorder +
  bcryptjs typo).
- 0 production regressions.

The 13 tenants.ts tests in slice 1 (`tenants-profile-
dashboard.test.ts`), 16 in slice 2 (`tenants-flex.test.ts`),
and 9 in slice 3 (`tenants-actions.test.ts`) all continued
to pass after the route reorder + bcryptjs fix.

## Items deferred — what S378 could target

### tenants.ts remaining slices (~14 routes left)

S374 + S375 + S376 + S377 covered 26 of tenants.ts's 40
routes (~65%). Remaining:

- **Admin-facing /:id/profile + /:id/transfer +
  /:id/available-units** (3 routes)
- **Profile patch + avatar POST + avatar GET +
  password** (4 routes)
- **Lease views + sign + addendums** (3 routes)
- **Work-trade + charge-account** (2 routes)
- **`/avatar-files/:filename`** (1 route — static-ish
  asset serve)
- **`enroll-credit-reporting` is the last single-route
  surface left in the OTP/credit cluster** (covered S376)

Natural next slice options:
- **Lease views slice** (3 routes — read lease, sign,
  addendums). Highest yield for surface-area pinning —
  this is the tenant's primary self-service surface.
- **Admin-facing :id/* slice** (3 routes). Lower yield;
  permission-gated read paths typically don't surface
  bugs in test sweeps unless the gates themselves are
  off.
- **Profile-self-edit slice** (4 routes). Medium yield;
  avatar upload paths sometimes hide path-traversal or
  permission bugs.

Recommend **lease views** for slice 5.

### Pending from S376 (carried)

- **FlexCredit ↔ rent-reporting product naming** — Nic-
  pending. Three options laid out in S376 handoff. Until
  resolved, admin.ts labels stay mislabeled.

### **NEXT FRESH-CONTEXT SESSION:** Checkr API wire-up

(Unchanged from S375/S376.) Memory note
`project_checkr_access_unblocked.md`. Slice 1 recon was
done in S376's opener — see that handoff for the file/env
recon notes and the three forks Nic owes.

### Architectural / non-test (carried)

- **Unicode-capable font in flexsuitePdf**
- **responsibleParty source-comment drift fix**

### Architectural (new from S377)

- **Invite token leakage** (concern A above) — Nic-pending
  until invite-email dispatch is wired
- **email_verify_token column overload** (concern B above)
- **Invite token expiry policy** (concern C above)

### Hardening flagged (carried)

- **logAdminAction targetId-uuid audit**
- **silent-failure pattern audit**
- **schema-drift audit** — 4 instances (S355/S360/S370/S374)
- **arc-completeness verification at close time**

### Vendor-blocked / walkthrough-blocked / dev-team scope

(All unchanged from S376.)

## Items deferred (cross-session docket, post-S377)

- Consumer-side retention framing decision (S300) — Nic-pending
- Campground Master import path — Nic-blocked on sample
- 2FA fan-out — walkthrough-blocked
- Yardi GL-export columns, Rentec template (S293) — vendor-blocked
- FlexCharge Business Account Agreement signature capture (S309 option B)
- FlexDeposit eligibility-check workflow (S309 option C)
- Standalone POS-operator auth (S309 option D)
- Deposit-return ↔ unpaid-installment offset architecture call — Nic-pending
- SchedulePage booking-vs-lease shape audit — walkthrough-blocked
- Embed Unicode-capable font in flexsuitePdf — open architectural pick
- Credit-score formula + recompute test coverage — locked v1.0.0
- Visual review of reconstructed PmInvitationsPage — walkthrough-blocked
- posTerminal service tests (Stripe-boundary, low marginal yield)
- action.url scheme validation (defense-in-depth, no live risk)
- pm.ts remaining slices: property invitations / Connect / payouts / drilldown
- units.ts remaining: /:id/economics / /:id/eviction-mode (walkthrough-blocked)
- properties.ts remaining: units/bulk + photos + listings + apply + applications
- logAdminAction targetId-uuid audit (codebase-wide hygiene pass)
- silent-failure pattern audit (try/catch swallow class)
- schema-drift audit (4 instances — codebase-wide grep priority)
- arc-completeness verification at close time (process hardening)
- tenants.ts remaining: admin /:id/* + profile-patch/avatar/password
  + lease views + work-trade + charge-account
- **(S376)** FlexCredit ↔ rent-reporting product naming —
  Nic-pending resolution
- **(S377)** Invite token leakage to landlord caller + log —
  needs email dispatch decision
- **(S377)** email_verify_token column overload — schema
  refactor candidate
- **(S377)** Invite token expiry policy — Nic-pending
- **NEXT FRESH-CONTEXT SESSION:** Wire background.ts → Checkr
  API (credentials in hand 2026-05-26)

## Nic-pending

- Stripe live keys + production webhook URL registered
- Resend domain verification
- Plaid production keys
- Stripe Terminal hardware
- Consumer-side retention framing decision (S300)
- FlexCredit Lender partner selection
- SLA § 9.1.4(iii) deposit-return offset framing call
- **(S376)** FlexCredit vs. rent-reporting product disambiguation
- **(S377)** Invite token leakage posture (response body +
  logs) — decide once email dispatch is wired
- **(S377)** email_verify_token column refactor (schema) —
  whether to split into per-flow columns
- **(S377)** Invite token expiry policy

## What S378 should target

**Recommended path:** next tenants.ts slice — **lease views**
(GET /lease, POST /lease/sign, GET /lease/addendums). Three
routes, the tenant's primary self-service surface, plausibly
high bug yield. ~8-10 tests.

Two production bugs in one slice (this session's count)
suggests the tenants.ts arc continues to surface real
issues, not just test-coverage gaps. Worth continuing the
arc through completion (~3-4 more slices) before pivoting
to Checkr.

---

End of S377 handoff. tenants.ts arc slice 4 of N covered
(3 invite-flow routes). **Tenant onboarding was 100%
broken (requireAuth gate) AND would have crashed 500 if the
gate were lifted (bcryptjs typo); both fixed.** 1139 tests
/ 66 files / 0 failures.
