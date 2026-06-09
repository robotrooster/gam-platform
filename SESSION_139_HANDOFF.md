# Session 139 Handoff

**Theme:** Walkthrough-prep backend pass. Notifications wired for
inspection / entry-request / dispute lifecycles + two missing
credit-ledger detectors (`tenancy_ended_with_balance` and
`balance_paid_post_move`) + two operational crons (inspection
scheduled-for reminders + entry-request stale auto-cancel).

Goal: when the live browser walkthrough happens, the multi-actor
flows actually fire pings between portals so the demo doesn't
require manual context-switching to find what just changed.

## Architecture decisions (this session)

### Notifications hook into existing helper

All new notify wrappers go through `createNotification(...)` in
`services/notifications.ts`. No schema additions for the
`notifications.type` column — it's free-form TEXT (no CHECK), so
new types like `inspection_ready`, `entry_request_new`,
`dispute_resolved` slot in without migrations. New types added:

- `inspection_ready` — landlord finished + signed; tenant ping
- `inspection_tenant_signed` — tenant signed; landlord ping
- `inspection_finalized` — both pinged with credit-ledger outcome
- `inspection_scheduled_reminder` — both pinged 24h before scheduled_for
- `entry_request_new` — tenant pinged on landlord create
- `entry_request_responded` — landlord pinged on grant/deny
- `entry_recorded` — tenant pinged on actual-entry record (with
  compliant/breach surface)
- `dispute_resolved` — disputing user pinged with outcome
- (Admin alert) `credit_dispute_opened` — routed through
  `createAdminNotification` (S132) for admin visibility

All notifications are best-effort (try/catch around the call) so a
notify failure doesn't break the underlying route or cron.

### Tenancy-balance detectors use invoices, not user_balance_ledger

`user_balance_ledger` tracks **payout-side** allocation (recipient
landlord/PM balances), not tenant debt. Tenant outstanding balance
lives on `invoices` (status pending/partial = unpaid, settled =
paid). Detector reads aggregate `total_amount` per `(lease_id,
tenant_id)` filtered by status to compute outstanding-vs-paid at
detection time.

### Operational nudges run hourly (not daily)

The inspection-reminder window is 24h-out from `scheduled_for`. A
daily cron risks missing the window or sending too far ahead
depending on when the inspection was scheduled. Hourly pass with an
idempotency column (`unit_inspections.reminder_sent_at`) keeps the
ping close to the boundary regardless of TZ. Same hourly job
handles the entry-request stale auto-cancel — pending requests with
`window_end + 6h` past auto-flip to `cancelled`.

## Shipped — backend

### Migration

```
20260505230000_inspection_reminder_sent_at.sql
```

Adds nullable `unit_inspections.reminder_sent_at TIMESTAMPTZ`.
schema.sql regenerated to 9366 lines.

### New emitters in `creditLedgerEmitters.ts`

- `emitTenancyEndedWithBalanceEvent` — tenant subject, -30%,
  network-visible.
- `emitBalancePaidPostMoveEvent` — tenant subject, +200,
  current-landlord visibility.

### New notify wrappers in `notifications.ts`

- `notifyInspectionReadyForTenant`
- `notifyInspectionTenantSigned`
- `notifyInspectionFinalized`
- `notifyInspectionScheduledReminder`
- `notifyEntryRequestNew`
- `notifyEntryRequestResponded`
- `notifyEntryRecorded`
- `notifyDisputeResolved`

### Route wiring

- `routes/inspections.ts` — `/sign` notifies the OTHER side based
  on signer role; `/finalize` notifies both with credit outcome.
- `routes/entryRequests.ts` — create notifies tenant; respond
  notifies landlord; record-entry notifies tenant with outcome.
- `routes/credit.ts` — open-dispute creates an admin alert via
  `createAdminNotification`; resolve-dispute notifies the
  disputing user with the outcome.

### New job files

- `jobs/balanceCreditDetectors.ts` —
  `processBalanceCreditDetectors`. Scans recently-terminated
  leases for unsettled invoices → emits
  `tenancy_ended_with_balance`. Scans subjects with prior
  ended-with-balance events whose lease balance has returned to
  zero → emits `balance_paid_post_move`.
- `jobs/operationalNudges.ts` —
  `processOperationalNudges`. Inspection 24h-out reminders +
  entry-request stale auto-cancel.

### Crons added (in `scheduler.ts`)

- `50 2 * * *` Phoenix — `processBalanceCreditDetectors`
- `15 * * * *` (hourly) — `processOperationalNudges`

## Validation

- `npm run db:migrate` → 1 applied
- `npx tsc --noEmit -p apps/api/tsconfig.json` → exit 0
- Live smoke against dev DB:
  - **`tenancy_ended_with_balance`** — synthesized expired lease +
    pending invoice; detector emitted 1 event ✓ (idempotent on re-run ✓)
  - **`balance_paid_post_move`** — flipped invoice to settled;
    detector emitted 1 event ✓ (idempotent on re-run ✓)
  - **Entry-request stale auto-cancel** — synthesized pending
    request 12h past window-end; cron flipped status to
    `cancelled` ✓
  - **Tenant subject chain** — both events appended in correct
    order, prev_hash linkage intact ✓
  - All smoke rows cleaned; dev DB returned to 0 events / 0
    subjects.

Notifications themselves are best-effort and don't currently have
a smoke harness — the existing `[SMS-STUB]` console + dev SMTP
catches them in real flows. Browser walkthrough will exercise all
three notify paths end-to-end.

## Files touched / created

```
apps/api/src/db/migrations/20260505230000_inspection_reminder_sent_at.sql  (new)
apps/api/src/db/schema.sql                                                 (regenerated)

apps/api/src/services/notifications.ts                                     (8 new wrappers)
apps/api/src/services/creditLedgerEmitters.ts                              (2 new emitters)

apps/api/src/jobs/balanceCreditDetectors.ts                                (new)
apps/api/src/jobs/operationalNudges.ts                                     (new)
apps/api/src/jobs/scheduler.ts                                             (2 new crons)

apps/api/src/routes/inspections.ts                                         (2 notify call-sites)
apps/api/src/routes/entryRequests.ts                                       (3 notify call-sites)
apps/api/src/routes/credit.ts                                              (admin alert + dispute-resolved notify)
```

## What this session did NOT do

- **No frontend changes.** Everything lands as either a workflow
  side-effect (notifications) or a cron-driven event emission
  (detectors). The existing UI surfaces on next page-load.
- **No live browser smoke yet.** Same ongoing gap. Now actually
  cheap to do because notifications will surface multi-actor
  events on the receiving portal.
- **No SMS provider.** `sendSMS` remains a console-stub. SMS
  branches in the new notify wrappers will console.log without
  actually delivering until Twilio (or an alternative) is
  integrated.
- **No notification preferences UI.** Tenants/landlords can't
  silence individual notification types yet — `notification_preferences`
  row defaults apply. If a user wants to mute
  `entry_request_new`, they'd need a SQL update today. Real UX
  is a follow-up.
- **No `recurring_lease_violation` detector.** That one needs a
  violation-type field on `lease_violation_notice_issued` event
  data that doesn't exist yet — drags in a small schema add.
  Deferred.
- **No eviction-event landlord-self-attest UI.** Bigger scope
  (probably 1 session of its own).

## Pre-launch backend status

Closed list updates:
- ✅ Inspection / entry-request / dispute notifications
- ✅ tenancy_ended_with_balance detector
- ✅ balance_paid_post_move detector
- ✅ Inspection scheduled-for reminders
- ✅ Entry-request stale auto-cancel

Open backend items:
- `recurring_lease_violation` detector (needs schema for
  violation type)
- Eviction-event landlord-self-attest UI (its own session)
- Notification preferences UI (already-existing
  `notification_preferences` table; no UI yet)
- Mobile push channel for notifications (currently email + SMS-stub
  + in-app only)

## What next session should target

The walkthrough-prep gate is now closed. Three reasonable next
moves:

1. **Live browser smoke walkthrough.** Recommended. Walk inspection
   + entry-request + credit flows in dev. Watch notifications fire
   between portals; verify the credit-ledger UI renders the right
   events; confirm crons would emit the right ledger events when
   leases end.
2. **Landlord screening view.** Read-only rendering of a prospective
   tenant's network-visible events + stats panel. Same shape as
   tenant `/credit` minus dispute/hardship buttons + a tenant
   subject_id input.
3. **Admin dispute resolution UI.** List open disputes, review
   evidence, resolve corrected/upheld/no_change. The corrected
   path needs an event-replacement form — biggest scope of the
   three.

Recommendation: smoke walkthrough first; then landlord screening
view; then admin dispute resolution UI.

## Notes for future-Claude

- `unit_inspections.reminder_sent_at` is set the first time the
  reminder fires for a given inspection. If the scheduled_for is
  later moved (e.g. landlord reschedules) the column should be
  cleared — there's no UI for rescheduling today, so this isn't
  a current bug, but flag it when reschedule lands.
- Stale auto-cancel uses a 6-hour buffer past `proposed_entry_window_end`
  before flipping. That window assumes the landlord might still
  post a record-entry slightly after the window closed (real life
  is messy). Tighten if the buffer feels too generous.
- Admin alert on dispute open uses `severity: 'warn'`. If volume
  becomes high, consider switching to `'info'` or routing to a
  dedicated dispute-review channel.
- The disputing-user lookup in `routes/credit.ts` joins through
  `credit_subjects` to find the underlying user. The query
  branches on `subject_type` because tenant and landlord subjects
  point at different tables. If `manager` or `property` subject
  types ever start opening disputes, extend that query.
- `processBalanceCreditDetectors` re-runs daily. If a tenant
  bounces between paid-off and re-incurred balance multiple times
  on the same lease, the detector emits `balance_paid_post_move`
  ONCE (the dup-check covers it), then never re-emits. That's
  intentional — the +200 is a one-time recognition that the
  balance was settled, not an ongoing zero-balance signal.
- Operational nudges hourly cron is in TZ-naïve mode (no
  `{ timezone: 'America/Phoenix' }` opts). The cron schedule is
  every hour at :15 regardless of TZ — that's intentional for an
  hourly job since "every hour" doesn't depend on local time.
