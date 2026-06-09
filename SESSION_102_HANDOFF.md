# Session 102 Handoff

**Theme:** Complete the email-failure surface by extending S101's ctx
pattern to the other 16 senders + their 14 active call sites. Also
unifies `emailAdverseActionNotice` (which had its own bespoke send
path) onto the central `send()` so it picks up auto-logging + ctx
attribution for free.

## Architecture decisions

**send() now returns `Promise<string | null>`.** Pre-S102 it returned
void. The new return is the Resend message id on success or null on
failure. This unification let `emailAdverseActionNotice` — which
previously called `resend.emails.send` directly to capture the message
id for stamping into the audit table — fold back onto `send()` like
every other sender. One less parallel path, one less bypass of the
log infrastructure. Existing void callers compile unchanged because
ignoring the return value is allowed.

**Per-sender ctx shape, not a generic blob.** Each sender accepts its
own narrowly-typed ctx (e.g. `{landlordId?; documentId?}` for
e-sign senders, `{landlordId?; backgroundCheckId?}` for background-check
senders). The sender then maps those typed fields into the generic
`EmailSendContext` (`relatedEntityType`/`relatedEntityId`) before
handing to `send()`. This keeps call sites self-documenting — a caller
can see at a glance what the sender expects — while the log table
stays generic.

**ctx remains optional everywhere.** A future caller (or one I missed)
that passes nothing still gets a row written with NULL metadata. The
admin global failure list catches it; the per-landlord list does not.
This is the right tradeoff: failures are visible somewhere, even when
the caller hasn't been wired up yet.

## Shipped

### apps/api/src/services/email.ts

- `send()` return changed from `void` to `Promise<string | null>`. JSDoc
  added explaining message-id semantics + the universal log row.
- 15 senders gained an optional ctx parameter mapped to a per-category
  log row. Coverage:

| Sender | Category | Entity attribution |
|---|---|---|
| `emailNewBackgroundCheck` | `background_new` | background_check |
| `emailBackgroundDecision` | `background_decision` | background_check |
| `emailPoolMatchInterest` | `pool_match_interest` | pool_match_request |
| `emailPoolTenantInterested` | `pool_tenant_interested` | pool_match_request |
| `emailMaintenanceCreated` | `maintenance_created` | maintenance_request |
| `emailSigningRequest` | `esign_signing_request` | document |
| `emailSigningCompleted` | `esign_signing_completed` | document |
| `emailSigningReminder` | `esign_signing_reminder` | document |
| `emailDocumentAutoVoided` | `esign_document_auto_voided` | document |
| `emailInvitation` | `invitation` | invitation |
| `emailAdverseActionNotice` | `adverse_action` | background_check |
| `sendDisbursementConfirmation` | `disbursement_confirmation` | disbursement |
| `sendOnTimePayInvitation` | `otp_invitation` | tenant |
| `sendLatePaymentNotice` | `late_payment_notice` | payment |
| `sendAchReturnAlert` | `ach_return_alert` | payment |
| `emailTenantOnboarded` (S101) | `tenant_onboarded` | tenant |

`emailAdverseActionNotice` refactored to call `send()` instead of
`resend.emails.send` directly — uses the new `string | null` return
to keep its message-id capture working.

### Caller updates (14 sites across 4 files)

- **routes/background.ts** (5 sites): `emailNewBackgroundCheck`,
  `emailBackgroundDecision`, `emailAdverseActionNotice`,
  `emailPoolMatchInterest`, `emailPoolTenantInterested` — all pass
  `landlordId` + the relevant entity id (background_check or
  pool_match_request).
- **routes/esign.ts** (3 sites): `emailSigningRequest` ×2 +
  `emailSigningCompleted` — all pass `doc.landlord_id` + `doc.id`.
- **routes/scopes.ts** (2 sites): `emailInvitation` create + resend
  paths — pass `landlordId` + `invitation.id`.
- **jobs/scheduler.ts** (4 sites — cron-driven):
  - Esign reminder query: `d.landlord_id` added to SELECT so it's
    available when `emailSigningReminder` fires.
  - Esign auto-void: `emailDocumentAutoVoided` gets
    `{landlordId: d.landlord_id, documentId: d.id}`.
  - Late-payment notice: `payment.landlord_id` + `payment.id` (already
    in `p.*`).
  - OTP invitation: `payment.landlord_id` + `payment.tenant_id`.

## Files touched

- `apps/api/src/services/email.ts`
- `apps/api/src/routes/background.ts`
- `apps/api/src/routes/esign.ts`
- `apps/api/src/routes/scopes.ts`
- `apps/api/src/jobs/scheduler.ts`
- `SESSION_102_HANDOFF.md` (this file)

No migrations, no schema changes. Backend code only.

## Validation

- `npx tsc --noEmit -p apps/api/tsconfig.json` → exit 0
- Live send smoke against Resend dev key (4 categories with ctx +
  1 no-ctx fallback): all 5 rows landed in `email_send_log` with
  the correct category, landlord_id, related_entity_*, and
  per-sender metadata. The no-ctx call landed with NULL attribution
  (still visible in the admin global query, invisible to
  per-landlord). `emailAdverseActionNotice` returned the
  message-id slot (null in this case because the dev send failed)
  while still writing its log row.
- `psql` post-test: `SELECT COUNT(*) FROM email_send_log` → 0
  (test pollution cleaned).

## Coverage status

Every email path in the API now writes a log row on every attempt.
Per-landlord attribution is live for the 14 call sites updated this
session plus the 3 from S101 (`emailTenantOnboarded` × 3 callers).
The 3 remaining sender exports in email.ts (`emailMaintenanceCreated`,
`sendDisbursementConfirmation`, `sendAchReturnAlert`) currently have
zero callers — kept as scaffolds per S85; the moment a real caller
materializes the sender already has ctx wired.

## What this session did NOT do

- **No frontend.** Per UI/UX standing rule. The two endpoints from
  S101 (`GET /api/landlords/me/email-failures`,
  `GET /api/admin/email-failures`) are now backed by full-coverage
  data; the dashboard card to surface them is a frontend session.
- **No retention/prune cron.** `email_send_log` rows accumulate
  indefinitely. Future session: tiny daily job to prune sent rows
  older than e.g. 90 days while keeping failures for full audit
  window.
- **No per-category alert thresholds.** Could imagine a cron that
  pages ops if `adverse_action` failure rate spikes (FCRA compliance
  risk), or if `disbursement_confirmation` failures cluster. Pure
  product call; not in S102.

## Pre-launch blockers still open

Same as S100/S101:
- Item 16 batch 2 — bank ACH origination provider.
- Item 16 batch 3+ — OTP enablement (FlexPay SetupIntent).
- Item 10 (S90) payment integration — gated on Item 16 batch 2.

## What next session should target

1. **Item 16 batch 2 — bank ACH origination provider**, when the
   rail call has been made.
2. **lease_fees.due_timing='move_out' / 'other' wire-up** — needs
   product decision on whether to build a move-out invoice
   generator or strip the unused enum values.
3. **Frontend pass for email failures** — wire the two endpoints
   into a dashboard card on the landlord portal + a panel in the
   admin ops console. UI session.
4. **email_send_log retention/prune cron** — small backend job; daily
   prune of old sent rows + retain failures past audit window. Could
   batch with deferred retention work for other log tables.
