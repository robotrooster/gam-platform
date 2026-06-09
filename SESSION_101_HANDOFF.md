# Session 101 Handoff

**Theme:** Email-failure surface to landlord UI (DEFERRED smaller items;
the TODO at landlords.ts:629). Backend infrastructure for the failure
log + the two query endpoints (landlord-scoped + admin-global). Pure
backend; no frontend in scope.

## Architecture decisions

**Best-effort logging at the central send() boundary.** Pre-S101 the
shared `send()` helper in `services/email.ts` swallowed every error with
a `console.error` and returned nothing. Failures were invisible — when
a tenant onboarding email bounced, the landlord had no surface to see it.
S101 makes `send()` log every attempt to a new `email_send_log` table
regardless of outcome. Logging itself is wrapped in its own try/catch:
a logging failure must never break a user-facing flow.

**Optional ctx, opt-in metadata.** All 17 senders in `services/email.ts`
funnel through `send()`. Forcing every sender to thread context would be
a 17-file refactor. Instead `send()` gained an optional 4th arg
(`EmailSendContext`) — existing callers compile unchanged and still get
a row written, just with NULL `landlord_id` / `related_entity_*` /
`metadata`. Per-landlord filterability arrives one sender at a time as
the metadata is wired through (S101 covers the tenant-onboarding sender
because that was the original TODO).

**Per-landlord scope vs admin-global scope.** Two endpoints, two use
cases. Landlord at `/api/landlords/me/email-failures` only sees failures
attributed to *their* landlord_id (defaults to last 30 days, max 200
rows). Admin at `/api/admin/email-failures` sees the global failure list
including rows with NULL landlord_id (defaults to last 7 days, max 500
rows; status filter param so it can also be used for delivery audit).

## Shipped

### Migration 20260503190000_email_send_log.sql

```
email_send_log
  id                   uuid PK
  to_email             text NOT NULL
  subject              text NOT NULL
  category             text          -- e.g. 'tenant_onboarded'
  status               text NOT NULL  CHECK ('sent' | 'failed')
  error_message        text          -- non-NULL when failed
  landlord_id          uuid → landlords(id) ON DELETE SET NULL
  related_entity_type  text          -- 'tenant' | 'lease' | etc
  related_entity_id    uuid
  metadata             jsonb         -- per-category escape hatch
  created_at           timestamptz NOT NULL DEFAULT now()
```

Two indexes:
- `idx_email_send_log_landlord_status_created` — per-landlord recent
  failures lookup (the landlord UI query).
- `idx_email_send_log_failed_recent` — partial index on
  `created_at DESC WHERE status='failed'` for the global ops query
  (failures are the rare row worth fast access).

### apps/api/src/services/email.ts

- New exported `EmailSendContext` interface
  (`category`, `landlordId`, `relatedEntityType`, `relatedEntityId`,
  `metadata`).
- `send()` gained optional 4th `ctx` arg. Captures status + error
  message (typed via the Resend error shape, not `any`); writes one row
  per attempt. Logging wrapped in try/catch — never breaks the caller.
- `emailTenantOnboarded` gained optional 5th `ctx` arg
  (`{ landlordId?, tenantId? }`); maps it to category='tenant_onboarded'
  and `related_entity_type='tenant'`.

### Three callers updated to pass ctx through

- `apps/api/src/routes/landlords.ts:626` (`/me/onboard-tenant` — the
  original TODO site). The TODO comment removed; replaced with a note
  pointing to the email_send_log surface.
- `apps/api/src/routes/landlords.ts:1763` (CSV bulk onboarding commit).
  Per-tenant `c.tenantId` threaded through.
- `apps/api/src/jobs/leaseParser/resolveIntent.ts:325` (lease parser
  resolve flow). `landlordId` + `tenantId` were already in scope.

### Two new endpoints

`GET /api/landlords/me/email-failures`
- requireLandlord
- Query params: `limit` (1–200, default 50), `since_days` (1–365, default 30)
- Returns rows scoped to `req.user.profileId AND status='failed'`
- Selects `to_email, subject, category, error_message, related_entity_*,
  metadata, created_at`

`GET /api/admin/email-failures`
- requireSuperAdmin
- Query params: `limit` (1–500, default 100), `since_days` (1–365,
  default 7), `status` ('failed' default; pass 'sent' for delivery
  audit), `category` (optional filter)
- Returns global rows (including NULL landlord_id rows from senders
  that don't yet thread ctx)

## Files touched

- `apps/api/src/db/migrations/20260503190000_email_send_log.sql` (new)
- `apps/api/src/db/schema.sql` (regenerated, 7481 → 7531 lines)
- `apps/api/src/services/email.ts`
  - `EmailSendContext` interface
  - `send()` ctx param + log INSERT + typed error capture
  - `emailTenantOnboarded` ctx param threading
- `apps/api/src/routes/landlords.ts`
  - Two `emailTenantOnboarded` call sites updated with ctx
  - Original TODO removed
  - New `GET /me/email-failures` endpoint at end of file
- `apps/api/src/jobs/leaseParser/resolveIntent.ts`
  - `emailTenantOnboarded` call site updated with ctx
- `apps/api/src/routes/admin.ts`
  - New `GET /email-failures` endpoint
- `SESSION_101_HANDOFF.md` (this file)

## Validation

- `npm run db:migrate` → 1 applied; schema.sql regenerated to 7531 lines
- `npx tsc --noEmit -p apps/api/tsconfig.json` → exit 0
- Live send smoke against Resend dev key: bogus address triggers a 403
  validation error from Resend; row lands in `email_send_log` with
  `status='failed'`, the verbatim Resend error message, the landlord_id
  attributed correctly when ctx provided, NULL when not. Both ctx and
  no-ctx paths exercised.
- Query-shape smoke: per-landlord query returns only attributed
  failures; global query returns both attributed and unattributed.
  Sent rows correctly excluded from the failures view.

## What this session did NOT do

- **No frontend.** Per UI/UX standing rule. Endpoints are callable; UI
  is its own session.
- **No ctx threading for the other 16 senders.** Each becomes a small
  follow-up that mirrors the `emailTenantOnboarded` pattern:
  add ctx to the sender signature, update its callers to pass
  landlord/entity context. Senders that go global (e.g.
  background-check applicant emails not attributed to a landlord)
  will land as NULL landlord_id in the global admin view.
- **No retention policy on email_send_log.** Rows accumulate
  indefinitely. A future session may want a daily prune job
  (e.g. delete rows >180 days old, keep failures >365 days for audit).
- **No sent-email digest endpoint for landlords.** Endpoint scope is
  failures only. Admin endpoint can list sent rows via
  `?status=sent` for forensic queries.

## Pre-launch blockers still open

Same as S100:
- Item 16 batch 2 — bank ACH origination provider.
- Item 16 batch 3+ — OTP enablement (FlexPay SetupIntent).
- Item 10 (S90) payment integration — gated on Item 16 batch 2.

## What next session should target

Top picks:

1. **Item 16 batch 2 — bank ACH origination provider**, the moment
   the rail call is made.
2. **lease_fees.due_timing='move_out' / 'other' wire-up.** Product
   decision: build move-out invoice generator (security deposit
   settlement, final pro-rata rent, damages) or strip the unused
   enum values.
3. **Email ctx thread-through pass for the other 16 senders.** Mostly
   mechanical: per sender, add the optional ctx arg, identify the
   1-3 callers, pass the in-scope landlord_id + entity context. Each
   sender expands per-landlord email surfacing coverage.
4. **email_send_log retention/prune cron.** Tiny job; daily delete of
   old sent rows + failures past audit window.
