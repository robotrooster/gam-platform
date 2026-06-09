# Session 142 Handoff

**Theme:** Autonomous polish pass on the credit-ledger surface
while Nic was AFK. Eleven scoped items, all small, all isolated,
none requiring decisions.

## Items shipped

### #1 Evidence display in admin disputes
- New endpoint `GET /api/credit/disputes/:id` returns the dispute
  joined with disputed-event metadata + an `evidence` array of
  the linked `dispute_opened` and `dispute_evidence_submitted`
  events.
- Detail endpoint pulls `dispute_opened` by its explicit
  `dispute_open_event_id` pointer (its `event_data` doesn't
  carry `dispute_id`) plus evidence-submitted events tagged with
  `dispute_id`.
- Admin detail panel renders an Evidence section with the open
  + each submitted evidence event, including their event_data
  pretty-printed.
- Admin detail panel switched from `selected.*` to `detail.*`
  reads so freshly-loaded data wins over the stale list-row.

### #2 Tenant my-disputes tracker
- New endpoint `GET /api/credit/disputes/mine` filtered to the
  caller's own disputing-subject. Tenant + landlord roles allowed.
- New tenant inline page `/my-disputes` listing the tenant's
  disputes with status badge, friendly event label, reason, filed
  date, resolved date.
- Nav entry "⚖️ My Disputes" added under Tenant rail next to
  My Record.

### #3 Resolver attribution in resolve events
- `resolveDispute` accepts `resolvedByUserId`; persists it in
  the resolution event's `event_data.resolved_by_user_id` for
  audit-grade attribution.
- `routes/credit.ts` `/dispute/:id/resolve` threads `req.user.userId`
  into the call so admins are automatically captured.

### #4 Lease-anniversary 7-day backfill window
- Detector widened from exact-day match to a 7-day rolling
  window. If a cron skips a day (deploy outage, etc.) the
  anniversary still fires. Idempotency check via
  `(lease_id, anniversary_year)` prevents dup emissions on
  re-run.

### #5 Inspection reschedule + reminder reset
- New `PATCH /api/inspections/:id` endpoint accepts
  `scheduled_for` and `notes` updates. Landlord-only. Forbidden
  on finalized/cancelled inspections.
- When `scheduled_for` changes, `reminder_sent_at` is cleared so
  the operational-nudges hourly cron will re-arm the
  24h-before-scheduled reminder against the new window.

### #6 Evidence count badge in admin list
- List endpoint subquery counts `dispute_evidence_submitted`
  events per dispute and returns `evidence_count` per row.
- Admin disputes table renders a blue badge with the count when
  evidence exists; helps admins prioritize disputes with
  evidence ready to review.

### #7 Mobile-responsive polish on credit-ledger pages
- Wrapped data tables in `overflow-x: auto` containers with
  `min-width` on the table itself so columns don't squeeze on
  narrow viewports — they scroll horizontally instead.
- Pages touched: InspectionsPage, EntryRequestsPage,
  InspectionDetailPage (checklist), TenantScreeningPage (KPI
  strip switched to `auto-fit minmax(180px, 1fr)`).

### #8 Notification preferences UI (tenant + landlord)
- Tenant: new `/notification-prefs` inline page listing 12
  notification types with email + SMS toggles. Subscribed nav
  entry under "🔔 Notifications" rail.
- Landlord: new `NotificationPrefsPage.tsx` with 13 landlord-
  relevant types. Nav entry under Settings.
- Both PATCH `/api/notifications/preferences` with the existing
  upsert semantics. In-app channel always on; only email/SMS
  toggleable.

### #10 Open-disputes KPI on admin Overview
- New query on Overview fetches `/credit/disputes?status=open`
  every 60s.
- When non-zero, surfaces a clickable gold alert above the KPI
  rows linking to `/disputes`. Quiet by default.

### #11 CLAUDE.md update
- Added "Credit Ledger v1 — feature-complete" section under
  Notable known items. Documents the eight DB tables, score
  model, emitter list, detector cron list, notification wiring,
  and frontend surfaces. Notes the `EVENT_LABEL` /
  `POSITIVE_EVENT_TYPES` duplication between
  `apps/landlord/src/pages/TenantScreeningPage.tsx` and
  `apps/tenant/src/main.tsx` that needs to be kept in sync when
  adding event types.

### Skipped this session
- **#9 Inspection landlord-side reschedule UI button.**
  Endpoint exists from #5; UI button to call it didn't make this
  session. Drag-and-drop or modal can land in a follow-up.

## Files touched / created

```
apps/api/src/routes/credit.ts                   (new dispute detail endpoint, my-disputes endpoint, evidence_count subquery, resolved_by_user_id thread-through, dispute_opened pull-by-id fix)
apps/api/src/services/creditDispute.ts          (resolvedByUserId param + persist in event_data)
apps/api/src/jobs/leaseLifecycleCreditDetectors.ts (7-day anniversary window)
apps/api/src/routes/inspections.ts              (PATCH endpoint with reminder reset)

apps/admin/src/main.tsx                         (Disputes detail panel: evidence display, detail.* swaps; Overview: open-dispute KPI)

apps/landlord/src/main.tsx                      (NotificationPrefsPage import + route)
apps/landlord/src/pages/NotificationPrefsPage.tsx (new)
apps/landlord/src/pages/InspectionsPage.tsx     (mobile responsive)
apps/landlord/src/pages/EntryRequestsPage.tsx   (mobile responsive)
apps/landlord/src/pages/InspectionDetailPage.tsx (mobile responsive)
apps/landlord/src/pages/TenantScreeningPage.tsx (KPI grid auto-fit)
apps/landlord/src/components/layout/Layout.tsx  (Notification Prefs nav entry)

apps/tenant/src/main.tsx                        (NotificationPrefsPage, MyDisputesPage; routes + nav entries)

CLAUDE.md                                        (Credit Ledger v1 — feature-complete entry)
```

No DB migrations. No emitter changes (just service-signature
extension on resolveDispute).

## Validation

- `npm run build` in `packages/shared` → clean
- `npx tsc --noEmit` on admin / landlord / tenant / api → all exit 0
- Live smoke against dev DB (5 phases):
  - Synthesized NSF event + opened dispute + submitted evidence ✓
  - Admin list `evidence_count` returns 1 ✓
  - Admin detail returns 2 evidence rows (opened + submitted),
    correct event_types ✓
  - Resolve corrected with `resolvedByUserId` captured the admin
    in resolve-event's `event_data.resolved_by_user_id` ✓
  - My-disputes endpoint shape matches with status flipped to
    `resolved_corrected` ✓
- Cleanup verified, dev DB returned to 0 events / 0 subjects /
  0 disputes

Smoke-discovered + fixed: the original detail-endpoint query
matched on `event_data ->> 'dispute_id'` for both event_type
filters, but `dispute_opened` events don't carry that field
(generated post-INSERT). Fixed by pulling the open event by
its explicit `dispute_open_event_id` pointer.

## Pre-launch frontend status

Closed list updates:
- ✅ Evidence display in admin disputes
- ✅ Tenant my-disputes tracker
- ✅ Resolver attribution in audit trail
- ✅ Lease-anniversary 7-day backfill
- ✅ Inspection reschedule + reminder reset
- ✅ Evidence count badge
- ✅ Mobile-responsive polish on credit-ledger pages
- ✅ Notification preferences UI (tenant + landlord)
- ✅ Open-dispute KPI on admin Overview
- ✅ CLAUDE.md updated

Open frontend items:
- Live browser smoke walkthrough across all credit-ledger UI
- Inspection reschedule UI button (endpoint exists; no UI
  trigger)
- Mobile-responsive polish on remaining pages (settings, profile,
  legacy admin pages)
- Tenant dispute evidence-submission UI (endpoint exists; no
  tenant button)

## What next session should target

The credit-ledger feature is end-to-end deployed across backend
+ 7 frontend surfaces (5 portal pages + 2 prefs pages) + 11
detector / cron jobs + dispute audit trail.

Recommended next moves in priority order:

1. **Live browser smoke walkthrough** (interactive, 30–60 min).
   The whole track is now polished enough that Nic can drive it
   in a real browser and catch UX rough edges. With
   notifications wired and prefs editable, the multi-actor
   demo flows naturally without context-switching pain.
2. **Tenant dispute evidence-submission UI.** Tenants can open
   disputes (S138) but can't currently attach follow-up evidence
   from the portal. The endpoint exists
   (`POST /api/credit/dispute/:id/evidence`); needs a button on
   the My Disputes page that opens a small modal accepting an
   evidence URL or document upload. Small; would close the tenant
   side of the dispute lifecycle.
3. **Inspection reschedule UI button** on the landlord
   inspection detail page. PATCH endpoint exists; needs a
   small modal trigger.
4. **`recurring_lease_violation` detector** (skipped earlier
   because it needs a violation-type field on
   `lease_violation_notice_issued` events that doesn't exist
   yet). Real next-step backend item.
5. **Eviction-event landlord-self-attest UI.** Spec says these
   are landlord-self-attested in v1; no UI exists for the
   landlord to record them.

## Notes for future-Claude

- Dispute open events don't carry `dispute_id` in their event_data
  by design — the dispute_id is generated by the INSERT after the
  event is appended. Any query that needs the open event by
  dispute id should join through `credit_disputes.dispute_open_event_id`
  rather than filtering event_data.
- `resolvedByUserId` is optional on `resolveDispute`. Service
  callers without an authenticated user (cron-driven future
  resolutions) can leave it unset; the field will be null in
  event_data. Filter on non-null when querying resolved-by-admin.
- Notification preferences default to email-on, SMS-off for any
  type the user has never explicitly toggled. The `notification_preferences`
  row only exists post-toggle; absent rows fall back to defaults
  in `createNotification`.
- The hardcoded type lists in the prefs UIs
  (TENANT_NOTIFICATION_TYPES, LANDLORD_NOTIFICATION_TYPES) must
  be kept in sync when new `notify*` wrappers land. The backend
  doesn't enforce a closed enum on `notifications.type`, so the
  UI list is the only source of truth visible to users.
- The lease-anniversary widened window uses
  `generate_series(0, 6)` to check the last 7 days. Postgres
  `EXTRACT()` on `NOW() - i*interval` handles year boundaries
  correctly (Jan 2 going back to Dec 26 of prior year). Tested
  via mental math; not stress-tested against actual edge dates.
- Mobile-responsive pass only touched the credit-ledger pages.
  Older pages (PaymentsPage, MaintenancePage, etc.) still use
  fixed-width tables. Wider polish pass is a follow-up.
