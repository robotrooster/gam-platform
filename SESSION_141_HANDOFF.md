# Session 141 Handoff

**Theme:** Admin dispute resolution UI. Last UI piece on the
credit-ledger track. Admin can list open disputes, review the
disputed event + tenant's stated reason, and resolve with
upheld / no_change / corrected (the corrected path includes an
event-replacement form that supersedes the original).

With this in place the credit-ledger feature is end-to-end
walkable: tenant opens dispute → admin sees it → admin resolves →
tenant gets notification + chain reflects the correction.

## Architecture decisions (this session)

### Single endpoint joins everything the resolver needs

Added `GET /api/credit/disputes?status=...` (admin-only). Each row
is the dispute joined with its disputed event and the disputing
subject's `(subject_type, subject_ref_id)`. The admin UI doesn't
need separate fetches per row to render the table or open the
detail panel — saves N round-trips on a list of 50 disputes.

### Master/detail layout in one page

The `Disputes` page is a single grid2 layout — list on the left,
detail panel on the right. Same pattern as the existing
`Tenants` and `PropertyReviews` admin pages. Selecting a row
populates the right panel; the resolution form is inline in that
panel (no separate modal).

### Corrected path has two modes

When admin picks "corrected", they choose between:

1. **Same type** — re-emit as the original `event_type` with
   `dispute_corrected: true` in event_data. Use case: the event
   happened but the data was wrong (e.g. wrong amount). Cleanest
   default — preserves event semantics while invalidating the
   bad payload via the supersede chain.
2. **Different type** — replace with a different event_type
   (e.g. swap a `payment_failed_nsf` for a `payment_received_on_time`).
   Use case: the original event shouldn't have fired at all
   because reality was different.

Both modes still set the disputed event's `superseded_by` to the
new event id, so score replay automatically picks up the change.

### Visibility + attestation are admin-controllable on corrected

Admin picks the `network_visibility` and `attestation_source` of
the replacement event. Defaults are
`visible_to_current_landlord` + `system_derived` because
admin-driven corrections aren't tenant-self-reported.

### Status tab semantics

Tabs: open / evidence_pending / resolved / all. The `resolved`
tab maps to `resolved_upheld` only (most common close-out shape).
If admin needs to see all three resolved subtypes at once they
use the `all` tab. Real product would benefit from a multi-status
filter — flagged as a follow-up below.

## What's live (UI)

### Admin portal — `/disputes`

- Status filter tabs: open / evidence_pending / resolved / all
- List panel: status badge, disputing-subject type + ref, friendly
  event label, reason, filed date
- Detail panel:
  - Disputed event metadata (type, occurred-at, attestation,
    visibility, dimension tags, supersede status)
  - Pretty-printed `event_data` JSON
  - Tenant's stated reason + notes
  - Resolution panel (only when status is open or evidence_pending):
    outcome buttons (upheld / corrected / no_change) +
    contextual explanation of what each does +
    corrected-path form (replacement-type toggle, visibility,
    attestation source) +
    resolver-notes textarea +
    Resolve button
  - For already-resolved disputes: read-only resolution summary
- Success banner pops above the page after a successful resolve

Nav entry "⚖️ Credit Disputes" added under the Compliance section.
Visible to admin and super_admin (no SuperAdminGuard wrapper —
both roles can resolve).

## Files touched / created

```
apps/api/src/routes/credit.ts                (new admin disputes-list endpoint)
apps/admin/src/main.tsx                      (Disputes inline page; route + nav added)
```

No DB migrations. No tenant or landlord changes. No emitter
changes.

## Validation

- `npx tsc --noEmit -p apps/admin/tsconfig.json` → exit 0
- `npx tsc --noEmit -p apps/landlord/tsconfig.json` → exit 0
- `npx tsc --noEmit -p apps/tenant/tsconfig.json` → exit 0
- `npx tsc --noEmit -p apps/api/tsconfig.json` → exit 0
- Live smoke against dev DB:
  - Synthesized an NSF event + opened a dispute against it ✓
  - List endpoint returns 1 row in the `open` bucket with all
    expected joined fields (event_type, event_data,
    occurred_at, attestation_source, dimension_tags,
    network_visibility, superseded_by) ✓
  - Resolved with `corrected` outcome → corrected event appended,
    original NSF marked `superseded_by` with reason
    `correction_after_dispute` ✓
  - Dispute status flipped to `resolved_corrected` ✓
  - Cleanup confirmed (including the `credit_scores` snapshot
    that the resolve flow auto-writes via `recomputeAndSnapshot`)

## What this session did NOT do

- **No live browser smoke walkthrough.** Same gap as S136-138-140.
  All credit-ledger UI is now in place and the walkthrough is the
  natural next move.
- **No multi-status filter.** Admin can pick one status or "all".
  Real volume might want "open + evidence_pending" together.
- **No evidence display.** Tenant can submit evidence via
  `POST /api/credit/dispute/:id/evidence`, which writes a
  `dispute_evidence_submitted` event to the chain. The admin UI
  doesn't surface those events yet — they're in the chain but not
  rendered in the detail panel. Follow-up: walk
  `credit_events WHERE event_data->>'dispute_id' = ?` and render
  any evidence attachments.
- **No bulk resolution.** One dispute at a time. If a class of
  disputes has the same root cause (data import bug etc.) admin
  has to resolve them individually.
- **No assigned-to-admin tracking.** When multiple admins are
  reviewing the queue, they'll race on the same disputes.
  `credit_disputes` doesn't have a `claimed_by` column. Add when
  it's a real problem.
- **No dispute-resolution audit log.** The resolution itself
  generates a `dispute_resolved_*` event in the chain, which IS
  the audit trail — admin's `userId` isn't captured in event_data
  though. If audit-grade attribution is needed, add resolver
  metadata to the resolve_event's event_data.
- **No mobile-responsive tuning.** Admin app is desktop-first;
  inherits no special small-screen handling.

## Pre-launch frontend status

Closed list updates:
- ✅ Admin dispute resolution UI (list, review, resolve, corrected
  path with event-replacement form)

The credit-ledger UI track is now feature-complete. Open frontend
items remaining:

- Live browser smoke walkthrough across all credit-ledger UI
  (inspection / entry-request / tenant credit / landlord screening
  / admin disputes)
- Mobile-responsive tuning across all credit-ledger UI
- Notification preferences UI
- Evidence display in admin dispute detail
- Admin assigned-to claim mechanism for multi-admin teams

## What next session should target

Two reasonable paths:

1. **Live browser smoke walkthrough** (recommended). The whole
   credit-ledger track is in place — backend + 5 frontend pages +
   notifications + crons + detectors. A real interactive walk
   through inspection → entry-request → credit-tenant → landlord
   screening → admin disputes will surface UX issues across the
   whole surface area, and is cheaper to fix before adding more.
2. **Polish pass** — evidence display in admin disputes, mobile
   responsiveness, notification preferences UI. All small
   individual items; could be one session of "polish and ship."

Recommendation: smoke first, then polish based on what surfaces.

## Notes for future-Claude

- The `Disputes` inline component lives below the `App` route
  table at line ~1330+ in `apps/admin/src/main.tsx`. Admin app
  is single-file by convention; don't extract.
- Class-name conventions in admin app are different from tenant
  app: primary button = `bp` not `bg-btn`, generic = `bg` not
  `bg-g`, badge variants = `ba/bg2/br/bmu/bgold/bb` not
  `b-amber/b-green/b-red/b-muted/b-gold/b-blue`, error alert =
  `ae` not `ar`. There are no `fl/fi/fg` form-field classes in
  admin — Disputes uses inline `inputStyle/labelStyle/fieldStyle`
  constants for those.
- The admin dispute-resolved notification flow (notifying the
  disputing user) was wired in S139's
  `routes/credit.ts /resolve` handler, NOT in the resolve service
  itself. The admin UI doesn't need to do anything extra — submit
  the resolve and the notify call fires automatically.
- `disputed_event_data` comes back as a JSONB object on the wire.
  The detail panel renders it via `JSON.stringify(..., null, 2)`
  inside a `<pre>` block. Long payloads scroll up to 160px and
  then become scrollable. Don't put PII through the ledger — the
  admin UI shows whatever's in event_data verbatim.
- On the corrected path, the replacement event's `event_data`
  copies the disputed event's payload then merges in
  `dispute_corrected: true` + `dispute_id`. If product wants to
  let admin override individual event_data fields (e.g. correct
  the dollar amount on a payment event), add a JSON editor to the
  corrected-path form. v1 keeps it simple.
