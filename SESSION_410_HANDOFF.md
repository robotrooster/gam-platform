# Session 410 — closed

## Theme

**S377 invite token hardening — second validation-
hygiene micro-session. Schema migration + 5 source-file
updates + 1 test-fixture update + 1 application of the
locked S398 decision.**

Suite at S409 close: **1798 / 96 files**.
Suite at S410 close: **1798 / 96 files** (no new tests
— updates to existing test cases in tenants-invite.
test.ts pin the new behavior). 0 failures. Runtime
1249.35s. Fourteenth consecutive fully-green full-suite
run.

Zero tsc regressions.

## What shipped (S398 decision S377)

The locked Nic decision was 3 sub-fixes:

1. **(c) Split overloaded `email_verify_token` column
   into three purpose-scoped columns** — shipped.
2. **(b) Invite tokens expire — 7-day window** — shipped
   for tenant invites (the only invite type with active
   minting code today).
3. **(a) Stop returning invite token in API response —
   deliver via email only** — **deferred** per the
   Nic memory note "(a) is blocked on email dispatch
   being wired — until then, keep the response shape
   but treat as known gap."

### Production bug class addressed

Pre-fix, ONE database column served three distinct
purposes:
- Email verification (auth.ts /verify-email)
- Tenant invite token (tenants.ts /invite + esign.ts
  resume URL)
- Landlord invite token (landlords.ts admin create /
  re-invite — though no active minting code exists for
  this case today; the column was overloaded as a
  forward-compat capability)

**Risk closed:** a tenant invite token could in
principle match a stale email-verification flow on a
different user (random crypto tokens — low collision
probability but the conceptual overlap was the
security smell). Splitting also enables per-purpose
expiry windows and isolated revocation.

## Migration

New file: `apps/api/src/db/migrations/20260607120533_split_invite_tokens.sql`

```sql
ALTER TABLE users
  ADD COLUMN tenant_invite_token text,
  ADD COLUMN tenant_invite_expires_at timestamptz,
  ADD COLUMN landlord_invite_token text,
  ADD COLUMN landlord_invite_expires_at timestamptz,
  ADD COLUMN email_verify_token_expires_at timestamptz;

CREATE UNIQUE INDEX ux_users_tenant_invite_token
  ON users (tenant_invite_token) WHERE tenant_invite_token IS NOT NULL;
CREATE UNIQUE INDEX ux_users_landlord_invite_token
  ON users (landlord_invite_token) WHERE landlord_invite_token IS NOT NULL;
```

Pre-launch posture: no backfill of existing
`email_verify_token` values into the new columns. Dev
seed data acceptable to leave behind. The existing
column is intact for its remaining email-verification
role.

## Files touched (source)

```
apps/api/src/
  db/migrations/20260607120533_split_invite_tokens.sql   (NEW)
  routes/tenants.ts                                       (3 places)
    - accept-invite reader: tenant_invite_token + 7d expiry gate
    - invite-info reader:   tenant_invite_token + 7d expiry gate
    - /invite setter:       tenant_invite_token + expires_at = NOW+7d
  routes/landlords.ts                                     (2 places)
    - line ~836 setter:     tenant_invite_token + 7d expiry
    - line ~2589 setter:    tenant_invite_token + 7d expiry
  routes/esign.ts                                         (2 places)
    - line ~1886 reader:    tenant_invite_token (resume URL)
    - line ~2274 reader:    tenant_invite_token (resume URL)
  jobs/leaseParser/resolveIntent.ts                       (1 place)
    - line ~252 setter:     tenant_invite_token + 7d expiry
  routes/tenants-invite.test.ts                           (existing test
                                                            fixtures updated)
```

NO changes to:
- `auth.ts` — keeps `email_verify_token` for its
  email-verification role (per existing
  no-expiry-by-design comment at lines 502-507; the
  S377 (b) expiry decision is specifically about
  invite tokens).
- Email verification tests (emailVerification.test.ts)
  — unchanged; tests its own column.

## Decisions made during build

| Question | Decision |
|---|---|
| Backfill existing `email_verify_token` rows into the new columns? | **No.** Per CLAUDE.md "Pre-launch is the right time for the schema migration." Dev seed data is acceptable to leave behind. New tokens always carry expires_at; legacy NULL-expiry rows are accepted by the read query as `(expires_at IS NULL OR expires_at > NOW())` for transition gracefulness. |
| Apply expiry to email_verify_token in S410? | **No.** auth.ts:502-507 has an explicit comment explaining email-verify intentionally doesn't expire ("sit in a spam folder for days, no security benefit to expiring"). The S377 (b) decision says "INVITE tokens expire" — invite is the operative word. The migration adds `email_verify_token_expires_at` as forward-compat capability but the enforcement is opt-in (no code reads it yet). |
| Are there active landlord-invite mints to wire? | **No.** Recon found that all `email_verify_token` setters in code today are for TENANT invites (activation URL goes to TENANT_APP_URL). The `landlord_invite_token` column is forward-compat — added so future landlord-invite flows have a purpose-scoped slot. |
| Implement (a) "stop returning token in API response"? | **No — deferred per Nic memory note.** Email dispatch isn't wired; removing the response field would break the current dev-only manual-paste flow. Mark as a known gap. |
| Ship the broader hygiene backlog in this session too? | **No.** S377 alone touches 6 source files; combining with other items would muddy the diff. Save other items for S411+. |

## Verification

- `npx tsc --noEmit` clean on apps/api (0 errors).
- `npm test` in apps/api: **1798 tests across 96 files,
  0 failures**, 1249.35s. **Fourteenth consecutive
  fully-green full-suite run.**
- Existing `tenants-invite.test.ts` updated to write
  the new columns + pin the 7d expiry assertion.
- 0 new test cases (this is a refactor that preserves
  behavior; the existing 15 tests now exercise the new
  columns).
- 0 production regressions.

## Architectural finding noted in passing

**Test infrastructure quirk (NOT a bug introduced by
S410):** running `npx vitest run <single-file>` from
apps/api connects to the dev DB (`gam`) instead of the
test DB (`gam_test`). The full-suite `npm test` works
correctly. Root cause: env-propagation timing between
globalSetup's `process.env.DB_NAME = TEST_DB_NAME` and
the worker fork that creates the pg pool. Not in
S410 scope; flag for a future hygiene pass on the
test infra.

## Items deferred — what S411 could target

### Validation-hygiene backlog (was 25, now 24)

Shipped in S410: S377 (b)+(c).

Remaining locked S398 decisions (4):
- S380 email validation (3 sub-fixes — format,
  uniqueness pre-check, disposable domain block)
- S384 contractor: ALL fields required
- S386 overpayment: vendor credit_balance schema +
  confirmation modal flow

S377 (a) is deferred-not-removed (email dispatch
wiring blocked).

Other hygiene items (~20):
- Test infra: single-file vitest run uses wrong DB
- S399 bulk-create input hardening
- S400 LEASE_TYPE_MATRIX ↔ CHECK drift
- S403 cross-landlord PI capture/cancel
- S405 bank_last4 null + ach_verified=TRUE defensive
- S405 /complete missing isExpired check
- S407 UNIQUE constraint on payments
  (unit_id, type, due_date)
- S408 finding A (monthly-statement off-by-one
  default — Nic-pending)
- S408 finding B ($15 hardcoded fee in 3 routes —
  Nic-pending)
- + earlier carry-forwards

### Per directive: fix all bugs before Checkr

Cumulative bug-sweep totals (post-S410):
- **44 production bug fixes** (no NEW bugs surfaced;
  S410 is a security-tightening refactor of a known
  overloaded column, not a bug discovery)
- 24 architectural / validation findings remaining
- 1798 tests across 96 files

## What S411 should target

**Recommended: continue hygiene batch.** Two options:

1. **S380 email validation (3 sub-fixes)** — the next-
   largest locked decision. Touches profile edit
   routes. Small surface; should fit in one session.
2. **Small bundle:**
   - S399 bulk-create input hardening
   - S403 cross-landlord PI capture/cancel
   - S407 UNIQUE constraint migration on payments

S380 closes another major S398 item. Recommend S411 =
S380 email validation.

**Alternatives:**
- S384 contractor required fields (validator
  tightening)
- S386 vendor overpayment (schema migration + UX)
- Test infra fix (single-file run wrong DB)
- Checkr wire-up

---

End of S410 handoff. **S377 invite token hardening
shipped: schema migration + 6 source-file updates +
test fixture updates.**

1798 tests / 96 files / 0 failures. Fourteenth
consecutive fully-green full-suite run.

**44 cumulative production bug fixes shipped across the
bug sweep.** Validation-hygiene backlog reduced from
25 to 24 (S377 (b)+(c) shipped; S377 (a) remains
deferred until email dispatch is wired).
