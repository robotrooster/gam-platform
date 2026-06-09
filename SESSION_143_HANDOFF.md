# Session 143 Handoff

**Theme:** Second autonomous polish pass on the credit-ledger
surface. Five scoped items shipped (six tasks; #B and #E merged
into one piece of UI). Closes the tenant side of the dispute
lifecycle, finishes the inspection scheduling story, and adds the
landlord-attest path with the recurring-violation detector that
goes with it.

## Items shipped

### #A Tenant evidence-submission UI

- "+ Evidence" button on each open dispute row in `/my-disputes`
  opens a modal that POSTs to `/api/credit/dispute/:id/evidence`.
- Modal accepts an evidence URL + free-text description (one-of
  required). Submits as `{evidence: {evidence_url, description, submitted_at}}`.
- On success, refreshes the my-disputes query so the dispute
  row state updates (open → evidence_pending if it was its first
  evidence).
- Closes the tenant side of the dispute lifecycle: open → submit
  evidence → wait for admin resolution → notification.

### #B + #E Inspection reschedule UI + scheduled-for surface

- `scheduled_for` now surfaces inline below the page header on
  the inspection detail page with a calendar icon and a
  Reschedule / Set time button.
- Clicking opens a modal with a `datetime-local` input pre-
  populated with the current value. PATCH `/api/inspections/:id`
  with the new scheduled_for; backend (S142) clears
  `reminder_sent_at` so the hourly cron re-arms the 24h-before
  notification against the new window.
- Modal also has a "Clear schedule" button to nullify
  `scheduled_for` if the landlord wants to remove a scheduled
  date entirely.
- Hidden on finalized/cancelled inspections.

### #C Eviction landlord-attest UI

Backend:
- New endpoint `POST /api/credit/attest`. Restricted to landlord +
  property_manager. Enforces:
  - Whitelisted `LANDLORD_ATTESTABLE_TYPES` (12 events: full
    eviction lifecycle + 4 conduct events including the
    `lease_violation_cured` positive)
  - Active tenancy relationship between attesting landlord and
    target tenant
  - Forces `attestation_source = landlord_self_reported_with_evidence`
  - Defaults `network_visibility = visible_to_gam_network` for
    adverse events; `visible_to_current_landlord` for positive
    cures (cured / dismissed / withdrawn)
  - Captures `attested_by_user_id` + `attested_by_landlord_id`
    in event_data for audit trail

Frontend:
- New `/record-event` page on landlord portal. Tenant search
  (live filter over occupants + tenant list), event-type select
  (grouped by Eviction / Conduct / Property), violation_type
  picker shown only when type is `lease_violation_notice_issued`,
  occurred-at datetime input, evidence URL, notes.
- Nav entry "Record Event" added under Screening section using
  Gavel icon.
- Surface includes a yellow info banner explaining the
  landlord-self-reported attestation + dispute path.

### #D recurring_lease_violation detector

- New job `processRecurringViolationDetector`. Scans last-24h
  `lease_violation_notice_issued` events with a `violation_type`
  set; for each, looks back 90 days for a prior matching
  violation on the same subject. Emits `recurring_lease_violation`
  tagged to the tenant subject with the prior + current event
  ids in event_data.
- Idempotent via `event_data ->> 'current_event_id'`: same
  triggering event won't double-emit.
- Cron at `35 2 * * *` Phoenix — sits between maintenance
  detectors (2:30am) and lease-lifecycle (2:45am).
- The schema for `violation_type` is event_data based; no DB
  migration needed. The new `/credit/attest` endpoint accepts
  it as a top-level field and threads it into `event_data.violation_type`.

## Files touched / created

```
apps/api/src/routes/credit.ts                          (new /credit/attest endpoint)
apps/api/src/jobs/recurringViolationDetector.ts        (new)
apps/api/src/jobs/scheduler.ts                         (cron added)

apps/admin/src/main.tsx                                (no changes this session)

apps/landlord/src/main.tsx                             (RecordEventPage import + route)
apps/landlord/src/pages/RecordEventPage.tsx            (new)
apps/landlord/src/pages/InspectionDetailPage.tsx       (scheduled_for surface, reschedule modal, RescheduleModal component)
apps/landlord/src/components/layout/Layout.tsx         (Gavel icon import + Record Event nav entry)

apps/tenant/src/main.tsx                               (SubmitEvidenceModal + button on MyDisputesPage; mobile-responsive table wrap)
```

No DB migrations. No emitter API changes (just a new emitter call
site through the existing `appendEvent`).

## Validation

- `npx tsc --noEmit` on admin / landlord / tenant / api → all exit 0
- Live smoke against dev DB (4 phases):
  - Synthesized 2 noise-violation events (35 days apart) →
    `processRecurringViolationDetector` emitted 1
    `recurring_lease_violation` event ✓
  - Chain contains the new event in correct order ✓
  - Idempotent re-run emitted 0 ✓
  - A 3rd event with `violation_type='unauthorized_pet'` (no
    prior of that type) correctly emitted 0 ✓
- Cleanup verified, dev DB clean

## Pre-launch backend status

Closed list updates:
- ✅ Tenant evidence-submission UI (closes tenant dispute
  lifecycle)
- ✅ Inspection reschedule + scheduled_for display
- ✅ Eviction + conduct landlord-attest (backend + UI)
- ✅ recurring_lease_violation detector

Open backend items:
- (only nice-to-haves left on the credit-ledger track)

## What next session should target

The credit-ledger track now has full backend + UI coverage for
every event type that has a real-world emission path in v1. The
remaining items are non-credit-ledger:

1. **Live browser smoke walkthrough** — still the biggest open
   item on the credit-ledger track. Now that landlord-attest +
   tenant-evidence-submission UIs are in place, the multi-actor
   demo flows top-to-bottom without any manual workarounds.
2. **Pivot off credit-ledger** — back to one of the older open
   items in CLAUDE.md:
   - `lease_fees due_timing` wire-up (needs product call from Nic)
   - OTP enablement (gated on FlexPay tier UX)
   - Master schedule cleanup (9 stub columns; dedicated session)
   - GAM Books AZ-specific tax form genericization (dedicated
     session)
   - Stripe sandbox testing (waiting on test API key)

Recommendation: smoke walkthrough first when you have a real-time
window; otherwise pivot to a non-credit-ledger track since this
one is at a clean handoff point.

## Notes for future-Claude

- The landlord-attest endpoint's relationship check (`canAttest`
  via JOIN on `lease_tenants` × `leases`) accepts `lt.status IN
  ('active','removed')` AND `l.status IN ('active','pending','expired')`
  to allow attesting eviction events on tenants whose lease has
  ended (eviction filings often land after move-out). If a
  landlord and tenant have NEVER had a lease relationship, the
  attest fails with 403 — correctly.
- `LANDLORD_ATTESTABLE_TYPES` is the closed enum for what the
  landlord can self-attest. Adding new types here = adding to
  the formula seed (if scoring) + the tenant `EVENT_LABEL` map
  + the landlord screening `EVENT_LABEL` map + this set + the
  `RecordEventPage` ATTESTABLE_EVENTS array. Keep all five in
  sync.
- Recurring-violation detector reads `violation_type` from
  event_data. If a violation event lands without a violation_type
  (older path that doesn't go through `/credit/attest`), the
  detector skips it. That's safe: those events still score, just
  don't compound into a recurring-lease-violation event.
- The reschedule modal accepts datetime-local input which is
  TZ-naive; the page converts to ISO via `new Date(value).toISOString()`
  using the browser's local TZ. Edge case: a landlord in Hawaii
  scheduling for a tenant in NYC will see Hawaii time in the
  picker. Acceptable for v1.
- Tenant `SubmitEvidenceModal` requires either evidence_url or
  description — backend doesn't enforce; UI guards. If a
  programmatic caller hits the endpoint with `{evidence: {}}`
  the dispute event still records, just with empty payload.
- The `/record-event` page only shows tenants with whom the
  landlord already has a relationship via `/units` + `/tenants`.
  If a landlord wants to attest eviction events for a former
  tenant who no longer appears in either list, they'd need a
  different tool (admin-side override). Out of scope for v1.
