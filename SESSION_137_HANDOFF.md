# Session 137 Handoff

**Theme:** Entry-request frontend pass on both portals. Mirrors the
S136 inspection UI shape (dual-party workflow, status-driven action
visibility) so the design language stays uniform across the two
operational flows that feed the credit ledger.

## What's live (UI)

### Landlord portal — three new pages

- **`/entry-requests`** — list with status filter. Shows reason,
  category, proposed window, hours-of-notice (warns when below 24h),
  actual-entered timestamp.
- **`/entry-requests/new`** — form picks unit + tenant + reason
  category + free-text reason + datetime-range window. Live
  feedback panel underneath the window inputs computes hours-of-
  notice and warns in amber if below the standard 24h.
- **`/entry-requests/:id`** — detail with the request facts, tenant
  response (or "awaiting"), and the **record-actual-entry** form.
  Submitting that form posts the actual entry timestamp; backend
  classifies as `compliant` (in-window + granted) or `breach`
  (anything else) and emits the matching ledger event. Page surfaces
  the outcome banner. Cancel button visible while still cancelable.

Nav entry added under Operations using the existing `DoorOpen` icon
(already imported by Layout). Visible to landlord, property manager,
and onsite manager.

### Tenant portal — two new inline pages

- **`/entry-requests`** — read-only list with status badge + the
  proposed window time + notice hours.
- **`/entry-requests/:id`** — facts panel + grant / deny buttons
  (only when status is `pending`). Optional reason text travels with
  the response. After response, surfaces the locked-in decision
  with timestamp + reason.

Nav entry added with 🚪 emoji to match the tenant rail's icon style.

## Files touched / created

```
apps/landlord/src/pages/EntryRequestsPage.tsx        (new)
apps/landlord/src/pages/NewEntryRequestPage.tsx      (new)
apps/landlord/src/pages/EntryRequestDetailPage.tsx   (new)
apps/landlord/src/main.tsx                           (3 routes added)
apps/landlord/src/components/layout/Layout.tsx       (1 nav entry)

apps/tenant/src/main.tsx                             (2 inline pages, 2 routes, 1 nav link)
```

No backend changes this session — the routes and emitters from S135
(`/api/entry-requests` POST/GET/respond/record-entry/cancel) all
work as built.

## Validation

- `npx tsc --noEmit -p apps/landlord/tsconfig.json` → exit 0
- `npx tsc --noEmit -p apps/tenant/tsconfig.json` → exit 0
- `npx tsc --noEmit -p apps/api/tsconfig.json` → exit 0 (regression)

No live browser smoke this session — see "What this session did NOT
do" below.

## Conventions kept

- Same per-file landlord page convention as S136 (InspectionsPage.tsx
  pattern); same inline-functions-in-main.tsx for tenant.
- Hours-of-notice surfaced both at create-time (live feedback panel)
  and on detail (color-coded value with AlertTriangle when sub-24h).
- Outcome (`compliant` vs `breach`) shown as a one-shot banner above
  the request facts. Same shape as the inspection finalize banner.
- Cancel is intentionally low-prominence (small button at the bottom
  of the detail) since it's a relatively rare action.

## What this session did NOT do

- **No live browser smoke.** Same gap S136 left open; S136 +
  S137 inspection and entry-request flows have not been clicked
  through in a real browser yet. That's the recommended next move.
- **No notifications integration.** Tenant doesn't get pinged when
  a new entry request lands; landlord doesn't get pinged when the
  tenant responds. Both reasonable follow-ups using existing
  `notifications` service.
- **No emergency-bypass UX.** `reason_category='emergency'` is
  selectable in the form but the UI doesn't visually treat it
  differently. Per the locked design the credit-ledger judgment
  still applies — if the urgency pushes notice below the window,
  a breach event fires. Whether to soften that for emergency
  category is a product call.
- **No stale-pending auto-cancel.** Pending requests past their
  window stay pending forever in the UI/data model. Backend has
  no auto-cancel cron either.
- **No "see comparison vs notice config" surface.** The 24h check
  uses a hardcoded threshold in the UI, not the landlord's
  `default_entry_notice_hours` column. Aligning those is a
  follow-up (read landlord row, use that field as the threshold).

## Pre-launch frontend status

Closed list updates:
- ✅ Landlord entry-request UI (list, create, detail with
  record-entry + cancel)
- ✅ Tenant entry-request UI (list, grant/deny detail)

Open frontend items (unchanged):
- Live browser smoke walk through inspection AND entry-request flows
- Credit-ledger tenant dashboard (own record, score-event count,
  stats panel, dispute open, hardship form)
- Credit-ledger landlord screening view (events + stats only,
  never the score)
- Credit-ledger admin dispute resolution UI
- Mobile-responsive tuning
- Notifications integration for both new workflows

## What next session should target

Two reasonable paths:

1. **Live browser smoke walkthrough** of inspection + entry-request
   flows (interactive). Lowest risk; shakes out the patterns before
   the credit-ledger UI lands on top of them.
2. **Credit-ledger tenant dashboard** — biggest scope remaining.
   Score display, stats panel rendering, event timeline, dispute
   open form, hardship-context form. Probably 1.5–2 sessions to do
   well; the tenant-side first (read-only event view + score-event
   count) and the dispute/hardship interaction second.

Recommended order: smoke walk first, then credit-ledger tenant
dashboard.

If Nic wants to keep building UI back-to-back, jumping into the
credit-ledger tenant dashboard is fine — the inspection + entry-
request patterns don't need anything from the dashboard, and any
issues found in browser smoke can be patched then.

## Notes for future-Claude

- Tenant inline-pages convention adds up. After this session
  `apps/tenant/src/main.tsx` is around 1450 lines. Still
  manageable; don't extract pages preemptively. If the dashboard
  pushes it toward 2000+ that's the time to revisit.
- The landlord-side `record-entry` form defaults the timestamp to
  "now" via the `toLocalIsoMinute(new Date())` helper. This is
  intentionally not a "post entry as it happens" stream — it's a
  retrospective record. If the landlord enters at 10am and posts
  at 11am, the 10am timestamp is what the credit ledger sees.
- The landlord nav entry uses icon `DoorOpen` which is already in
  the Layout import list (used by Unit Overview + Master Schedule).
  Nothing new to import.
- Tenant inline page functions for entry-requests use a separate
  `entryStatusBadge` helper (parallel to inspection's
  `statusBadge`). Kept them separate even though they're similar
  because the tenant rail uses different status labels per
  workflow (entry-request has `breached`, `granted`, etc. that
  inspection doesn't).
