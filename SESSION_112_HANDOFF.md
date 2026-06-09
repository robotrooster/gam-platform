# Session 112 Handoff

**Theme:** PM Companies — staff invitation flow (email + accept-token).
Composes the S101+ email infrastructure with the S80 invitation pattern,
scoped to `pm_company_id` instead of `landlord_id`. Closes the last
non-frontend gap in the PM Companies surface.

## Architecture decisions

**Separate `pm_invitations` table, not extending `invitations`.** The
existing in-house invitations table keys on `landlord_id` and constrains
`role` to in-house worker roles via CHECK. Adding pm_company_id +
PM staff roles would loosen those constraints in ways that risk in-house
correctness. Two tables, two clean role/scope CHECK lines. Same posture
as S111's `pm_monthly_fee_accruals`.

**Public `/accept` endpoint, requireAuth gating it.** The accept flow
needs the recipient to be logged in (the route binds the invitation to
`req.user.userId`). But the accept endpoint itself shouldn't be behind
the standard `pmRouter.use(requireAuth)` since the acceptance is its
own auth gate. Solution: a sibling sub-router mounted before
`pmRouter.use(requireAuth)`, with `requireAuth` re-applied to the
accept handler specifically. Keeps the auth surface explicit
without mixing public-endpoint gating into the main router's middleware
chain.

**Email match is enforced at accept.** The recipient's logged-in user
account email must match `lower(pm_invitations.email)`. Without this,
a stolen accept token from a leaked email would let any logged-in
user join the company. Defense in depth — the token itself is 32-byte
random, but the email match adds a second factor.

**Partial UNIQUE on (pm_company_id, lower(email)) WHERE status='pending'.**
Prevents two concurrent pending invites to the same email per company,
without blocking the legitimate "re-invite after acceptance/revocation"
flow. Accepted/expired/revoked rows survive for audit and don't conflict
with new pending rows.

**Existing-membership pre-check at the create route.** Before INSERTing
a new invitation, the route checks `pm_staff` for an active row with
the recipient's email. Rejects 409 if found — saves the recipient an
unnecessary email and the operator a confusing accept-then-409 cycle.
The accept-time race is also defended: a duplicate active membership
inside the accept transaction is caught and returns 409.

**Invitation TTL: 24 hours.** Same as the in-house invitation pattern.
The expiry cron extended to sweep both tables.

**Email category `pm_invitation`** in `email_send_log` (S101+ failure
dashboard) — distinct from the in-house `invitation` category for
filterability.

## Shipped

### Migration `20260504030000_pm_invitations.sql`

```
pm_invitations
  id, pm_company_id (CASCADE), email, role (CHECK),
  permissions jsonb, invited_by_user_id (CASCADE),
  status (CHECK pending/accepted/expired/revoked),
  token (UNIQUE), expires_at,
  accepted_at, accepted_user_id (SET NULL),
  revoked_at, revoked_by_user_id (SET NULL),
  created_at
```

Indexes:
- `pm_invitations_token_unique` — UNIQUE on `token` (accept-by-token lookup)
- `pm_invitations_unique_pending` — partial UNIQUE on
  `(pm_company_id, lower(email)) WHERE status='pending'`
- `idx_pm_invitations_company_status` — list/filter by company
- `idx_pm_invitations_email_status` — partial index on
  `(lower(email), status) WHERE status='pending'` for email-based
  pending lookups

### apps/api/src/services/email.ts

New exported `emailPmInvitation(to, inviterName, companyName, role,
acceptUrl, ctx?)`. Calls `send()` with category=`pm_invitation`,
`relatedEntityType='pm_invitation'`, and metadata including
`role` + `pm_company_id` + `company_name`. landlordId intentionally
null (PM invitations don't belong to a landlord scope).

### apps/api/src/routes/pm.ts

Five new endpoints:

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST`   | `/companies/:id/invitations`              | owner only | create + email |
| `GET`    | `/companies/:id/invitations`              | active staff | list pending+recent |
| `POST`   | `/companies/:id/invitations/:invId/resend`| owner only | regenerate token + resend |
| `DELETE` | `/companies/:id/invitations/:invId`       | owner only | revoke (pending only) |
| `POST`   | `/invitations/accept`                     | requireAuth | bind token to caller's user |

`buildPmAcceptUrl()` reads `PM_ACCEPT_URL_BASE` env or falls back to
`{LANDLORD_APP_URL}/pm/accept-invitation`. The frontend route can be
either landlord-portal-hosted or its own dedicated PM portal — the env
override gives the deployment flexibility without code change.

### apps/api/src/jobs/scheduler.ts

`processInvitationExpiry` extended to also sweep pm_invitations. No
platform_events row written for PM expiries (the existing
`platform_events.subject_type` CHECK only allows `'invitation'` for
in-house). Future session can add `'pm_invitation'` to that CHECK if
ops wants the same audit-event surface.

## Files touched

- `apps/api/src/db/migrations/20260504030000_pm_invitations.sql` (new)
- `apps/api/src/db/schema.sql` (regenerated)
- `apps/api/src/services/email.ts` (new emailPmInvitation export)
- `apps/api/src/routes/pm.ts` (5 new endpoints + helpers)
- `apps/api/src/jobs/scheduler.ts` (expiry sweep extended)
- `SESSION_112_HANDOFF.md` (this file)

## Validation

- `npx tsc --noEmit -p apps/api/tsconfig.json` → exit 0
- 10-step end-to-end smoke against dev DB:
  1. Company + auto-owner pm_staff row created
  2. Invitation INSERT with 32-byte token + 24h expiry
  3. `emailPmInvitation` call → row landed in `email_send_log` with
     correct category + related_entity attribution (Resend's
     testing-mode 403 captured as `status='failed'` — expected in dev)
  4. Partial UNIQUE rejected duplicate-pending invite for same email
  5. Accept transition: status='accepted', accepted_user_id set
  6. pm_staff row created via ON CONFLICT DO UPDATE shape
  7. Fresh pending invite allowed after acceptance (status discriminator
     in partial unique works correctly)
  8. Expiry cron flipped past-expires_at pending rows to 'expired'
  9. Revoke transition: status='revoked', revoked_at + revoked_by_user_id
  10. CASCADE on pm_companies DELETE removes all invitations
- Dev DB returned to zero pm_invitations / pm_companies / pm_staff /
  pm_invitation log rows post-test

## What this session did NOT do

- **No frontend.** Per UI/UX standing rule.
- **No signup flow integration.** The accept endpoint requires the
  recipient to already have a GAM user account. A new-user flow that
  signs up + accepts in one shot would need a separate route or a
  signup-then-loop-back UX. Today: existing users only.
- **No platform_events audit row for PM invitation expiries.** Skipped
  because the table's `subject_type` CHECK doesn't include
  `'pm_invitation'` — adding it is a one-line CHECK update if ops
  wants the unified audit-event stream.
- **No cross-company role rules.** A user can be staff at multiple
  pm_companies — that's allowed by the schema (`pm_staff` UNIQUE is
  per-(company, user)). Accept route doesn't enforce any cross-company
  policy; future product decisions might want exclusivity for owner
  roles.
- **No `maintenance_markup_pct` PM trigger.** Same gating as S111 —
  needs maintenance vendor invoice flow.

## Pre-launch blockers still open

Same as S100–S111:
- Item 16 batch 2 — bank ACH origination provider
- Item 16 batch 3+ — OTP enablement
- Item 10 — utility billing payment integration

PM Companies subsystem is now feature-complete on every dimension
that doesn't depend on an unbuilt sibling subsystem (maintenance
invoice flow). All four entry points exist:
- Company creation (S109)
- Staff CRUD by uuid (S109)
- Staff invitation by email (S112) ← this session
- Property assignment (S109)
- Money flow per payment (S110)
- Money flow monthly accrual (S111)
- Money flow on lease creation (S111)
- Owner-visibility view (S110)
- Maintenance notification path (S109)

## What next session should target

1. **Frontend pass.** The PM Companies surface, the email-failure
   dashboard (S101+), the owner pm-impact view (S110) all need UI.
   Per UI/UX standing rule, batch when ready.
2. **Master Schedule booking UI** — schema shipped S92, UI gap.
3. **Sub-permission gating on routes** — catalog defined S81,
   enforcement deferred.
4. **Maintenance vendor invoice flow** — unlocks
   `maintenance_markup_pct` PM trigger and likely owner-side
   maintenance billing.
5. **Compliance-table retention policy** (S104 deferral).

Recommend **#1 (frontend pass)** when you're ready — backend has
landed enough surface to make UI work productive across multiple
features at once.
