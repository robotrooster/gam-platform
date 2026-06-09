# Session 135 Handoff

**Theme:** Credit-ledger emitter completion — entry-request workflow,
maintenance auto-detectors (recurring repairs, habitability),
lease-lifecycle auto-detectors (anniversary, multi-landlord clean
history), lease-end emission wired into the existing daily processor.

Closes the backend-emitter gap that S134 left: every event type in
the v1.0.0 formula now has either a workflow emission or a detector
cron firing it. Self-reported / future-integration types (utility/
telecom/auto_loan/etc., bill_pay) remain forward-compat-only as
designed.

## Architecture decisions (this session)

### Entry-request workflow

Three-step lifecycle:
1. **Landlord creates** request with reason + reason_category +
   proposed entry window. Notice window (gap from notice_given_at
   to window start) is recorded but NOT enforced at creation;
   compliance is judged at record-entry time. Landlords have a
   per-landlord default `default_entry_notice_hours` (default 24).
   Emergency reason_category implicitly bypasses notice in the
   landlord's own internal logic — credit-ledger compliance
   judgment still applies.
2. **Tenant grants/denies** via `/respond`. Granted before window
   start → tenant `entry_request_granted_within_window` (+50).
   Denied → no score (denial is a tenant right; informational).
3. **Landlord records actual entry** moment via `/record-entry`.
   - Within proposed window AND request was granted →
     `proper_entry_notice_given` (landlord, +25).
   - Outside window OR no grant → `entry_compliance_breach`
     (landlord, -10%, network-visible).

`entry_request_made` (informational) is reserved for an explicit
emit when the route is fully GA-mounted; per the locked anti-fraud
rule, the landlord's unilateral request is not scored.

### Maintenance credit detectors (daily)

Two passes inside one cron at **2:30am Phoenix**:

1. **`recurring_repair_same_issue`** — finds completed maintenance
   requests resolved in the last 24h that have a prior completed
   request on the SAME unit + SAME category, completed within 90
   days BEFORE the current request was opened. Emits the event
   tagged to the landlord subject. Idempotent via
   `event_data ->> 'current_request_id'` lookup.

2. **`habitability_complaint_unresolved_30d`** — finds OPEN (not
   completed/cancelled) maintenance requests in the
   `hvac/plumbing/electrical/structural` set that have been
   open >30 days. Emits the event once per request, idempotent
   via `event_data ->> 'maintenance_request_id'`.

Detection sits BEFORE the nightly recompute (3am) so any events
emitted today flow into tonight's score snapshot.

### Lease-lifecycle credit detectors (daily, **2:45am Phoenix**)

1. **`lease_anniversary`** — for every active lease whose
   `start_date`'s month-day matches today AND the lease has been
   active ≥12 months, emits per active tenant. Idempotent via
   `(lease_id, anniversary_year)` lookup.
2. **`multi_landlord_history_clean`** — tenant subjects who have
   ≥2 distinct landlords across `lease_terminated_natural` events
   AND zero adverse events on their chain AND no prior emission
   get the lifetime +500 event. Adverse-event keyset is hardcoded
   in the detector (kept in sync with the formula's negatives map;
   future formula version updates re-sync).

### Lease-end ledger emission wired in `processLeaseEnds`

The 2am Phoenix lease-end processor now emits:
- `lease_terminated_natural` (per active tenant + single landlord)
  on the no-auto-renew expiry branch
- `lease_renewed` (per tenant + landlord) on the auto-renew
  `extend_same_term` branch

The `convert_to_month_to_month` branch does NOT emit — month-to-
month transition is neither termination nor renewal in scoring
terms. (Reserved for v1.1.0 if Nic wants to assign points later.)

Both emissions are wrapped in their own try/catch — an emission
failure does not roll back the lease state change.

## Shipped — backend

### Migration

```
20260505220000_entry_request_workflow.sql
```

Adds `landlords.default_entry_notice_hours` (NOT NULL DEFAULT 24)
and creates `unit_entry_requests` + `unit_entry_request_responses`.
Schema regenerated to 9365 lines.

### Service additions (`services/creditLedgerEmitters.ts`)

- `emitEntryRequestResponseEvents` (tenant-side grant/deny)
- `emitEntryRecordedEvents` (landlord-side compliance/breach)
- `emitRecurringRepairEvent` (landlord)
- `emitHabitabilityUnresolvedEvent` (landlord)
- `emitMultiLandlordHistoryCleanEvent` (tenant)
- `emitLeaseTerminatedNaturalEvents` (tenant + landlord)
- `emitLeaseRenewedEvents` (tenant + landlord)
- `emitLeaseAnniversaryEvent` (tenant)

### Routes

- `routes/entryRequests.ts` mounted at `/api/entry-requests`:
  - `POST /` create (landlord)
  - `GET /` list, `GET /:id` detail (visibility-filtered)
  - `POST /:id/respond` tenant grant/deny
  - `POST /:id/record-entry` landlord posts actual entry
  - `POST /:id/cancel` landlord cancel pre-record

### Crons

In `jobs/scheduler.ts`:
- `30 2 * * *` Phoenix — `processMaintenanceCreditDetectors`
- `45 2 * * *` Phoenix — `processLeaseLifecycleCreditDetectors`

`processLeaseEnds` (existing 2am) now emits credit events post-
update via a new local `emitLeaseLifecycleEvent` helper.

### New job files

- `jobs/maintenanceCreditDetectors.ts`
- `jobs/leaseLifecycleCreditDetectors.ts`

## Validation

- `npm run db:migrate` → 1 applied; schema.sql regenerated
- `npx tsc --noEmit -p apps/api/tsconfig.json` → exit 0
- Live smoke against dev DB:
  - **Entry-request compliant path** — tenant grant before window
    + landlord entry within window → `entry_request_granted_within_window`
    on tenant chain, `proper_entry_notice_given` on landlord chain ✓
  - **Entry-request breach path** — landlord entry 5 hours after
    window closed → `entry_compliance_breach` on landlord chain ✓
  - **Recurring-repair detector** — two completed plumbing requests
    on same unit (one 60 days ago, one 1 hour ago) → 1 event
    emitted ✓
  - **Habitability detector** — 45-day-old open plumbing → 1
    event emitted ✓
  - **Idempotency** — re-running both detectors → 0 emissions ✓
  - **Lease-lifecycle detector** — runs cleanly against current
    data (no qualifying lease anniversary or multi-landlord clean
    history), exits with 0 emissions ✓
  - All smoke rows cleaned; dev DB returned to 0 events / 0
    subjects / 0 entry-requests

## Files touched / created

```
apps/api/src/db/migrations/20260505220000_entry_request_workflow.sql  (new)
apps/api/src/db/schema.sql                                            (regenerated)

apps/api/src/services/creditLedgerEmitters.ts                         (8 new emitters)

apps/api/src/routes/entryRequests.ts                                  (new)

apps/api/src/jobs/maintenanceCreditDetectors.ts                       (new)
apps/api/src/jobs/leaseLifecycleCreditDetectors.ts                    (new)
apps/api/src/jobs/scheduler.ts                                        (3 crons added; processLeaseEnds emits)

apps/api/src/index.ts                                                 (entryRequestsRouter mount)
```

## What this session did NOT do

- **No frontend.** Entry-request UI, tenant approve/deny screens,
  landlord entry-record button — all batched per the standing
  UI/UX rule.
- **No `convert_to_month_to_month` emission.** Treated as no-op
  for now. If product wants a small positive (it IS a continuation
  signal), publish v1.1.0 with a value and a single emission line
  added in the processor.
- **No emergency-reason notice-bypass logic.** The route accepts
  `reason_category='emergency'` and stores it, but the
  compliance-judgment path doesn't currently special-case it. If
  state law for the landlord supports emergency entry without
  notice, that's a per-landlord config that lives outside the
  credit-ledger judgment. Flagged as a follow-up.
- **No tenant-portal expiry on stale entry-requests.** A request
  left in `pending` past its window doesn't auto-cancel. Future
  cron pass.
- **No automatic `expiration_notice_sent_at` → ledger event.** The
  lease-end notice flow already sends emails (S18 work); whether
  that should emit a credit ledger event is a product call.

## Pre-launch backend status

Closed list updates:
- ✅ Entry-request workflow (schema + routes + emitters)
- ✅ Maintenance credit detectors (recurring repair + habitability)
- ✅ Lease-lifecycle credit detectors (anniversary + multi-landlord
  clean)
- ✅ Lease-end ledger emission (terminated_natural, renewed)

Open items (unchanged):
- lease_fees due_timing wire-up
- OTP enablement (gated on FlexPay tier UX)
- Stripe sandbox testing (waiting on test API key)
- Frontend pass for everything backend-ready

## What next session should target

The credit-ledger backend is now feature-complete in the sense that
every event type in the v1.0.0 formula either has a workflow emitter
or a detector cron. **Frontend pass is now the natural target.**

Recommended order (from prior session, unchanged):
1. **Inspection UI** — landlord checklist + photo upload + tenant
   sign-off + landlord finalize. Smaller scope, immediate
   operational value.
2. **Entry-request UI** — landlord create form, tenant approve/deny
   from notification, landlord record-entry button. Pairs naturally
   with inspection UI (similar shape: dual-party workflow).
3. **Credit-ledger UI** — tenant dashboard (own record + score
   stats), landlord screening view (visible events for prospective
   tenants, NO score), dispute lifecycle, hardship-context form.

Alternative backend tracks if Nic wants to keep grinding:
- **`tenancy_ended_with_balance` emission** — fires when a lease
  ends with outstanding balance. Currently no emitter; needs a
  detector that walks lease-end events + checks tenant
  `user_balance_ledger` for non-zero remaining balance at the
  termination moment.
- **`balance_paid_post_move` detection** — when a former tenant's
  outstanding balance returns to zero post-termination. Walks
  payments + ledger.
- **Eviction event manual UI** — admin tool to record
  `eviction_notice_filed`, `eviction_hearing_*`,
  `eviction_hearing_judgment_issued` events without waiting on a
  full eviction subsystem build. Per the locked design these are
  landlord-self-attested in v1.

## Notes for future-Claude

- Adverse-event keyset in `leaseLifecycleCreditDetectors.ts` MUST
  be re-synced when the formula publishes a new version with
  added/removed negative event types. Treat as a pair: edit the
  formula seed migration → add a new migration republishing the
  formula → bump the keyset.
- Entry-request `notice_window_hours` is recorded at creation but
  the credit-ledger judgment uses `proposed_entry_window_start` as
  the cooperation-deadline anchor. If the legal-notice window
  needs to be its own scoring threshold (e.g. enter with <24h
  notice = breach regardless of window-window match), wire that
  in by adding a separate emitter helper that compares
  `(window_start - notice_given_at)` to landlord's
  `default_entry_notice_hours`.
- `processMaintenanceCreditDetectors` looks at last 24h of
  resolved requests for recurring detection. If the cron skips
  a day (deploy outage etc.), recurring events from that gap may
  be missed. Future hardening: walk an explicit
  `last_processed_at` watermark instead of the rolling 24h.
- Lease-end credit emission is wrapped in its own try/catch and
  uses a separate connection (NOT in the lease-state-update
  transaction). The trade-off is intentional: if credit emission
  fails, the lease state change is durable and the next nightly
  recompute cron will pick up an inconsistent picture for one
  day, but no tenant gets stuck in a half-terminated state.
