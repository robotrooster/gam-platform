# Session 138 Handoff

**Theme:** Tenant credit-ledger dashboard. The biggest remaining
frontend piece on the credit-ledger track. Tenants now have a
self-serve view of their GAM behavioral record + dispute open flow
+ hardship-context capture, all backed by the visibility-gated
`/api/credit/*` endpoints from S134.

Landlord screening view + admin dispute resolution UI deferred to
their own session — keeps this build focused.

## Architecture decisions made (this session)

### Score is intentionally not displayed

Per the locked design rule (score is internal-only, gated to GAM
lending services), the tenant dashboard surfaces:
- **Total events** (count)
- **On-time payment %** (lifetime, from stats panel)
- **On-time streak** (current + longest)
- **Event timeline** (grouped by month, with dimension tags +
  attestation source)
- Hardship context entry point + per-event dispute button

The composite score itself is NOT shown to the tenant. If product
later wants tenants to see a non-numeric strength indicator
("Excellent / Good / Fair"), that's a banded rendering of the
score in a tenant-facing service, not a raw exposure of the
gam_internal_only number.

### Event-tone classification at the UI layer

A small `eventTone(eventType)` helper splits events into
positive / negative / neutral so the timeline can show a colored
dot + a "Dispute" button only on adverse events. The keyset
mirrors the formula's positives map (kept in the file as
`POSITIVE_EVENT_TYPES`); future formula version updates will
require a re-sync. Acceptable trade-off for keeping the UI
self-contained.

### Dispute flow is event-row inline, not a separate page

Each negative event has its own "Dispute" button that opens a
modal pre-bound to that event id. No separate "disputes" route
because the only thing the tenant does today is open one + see
the resulting `dispute_opened` event in their own timeline.
Once admin resolution UI lands, a tenant-side "my disputes"
list becomes worth building.

### Hardship is a one-shot form, not an editable history

Hardship context appends a ledger event + a `credit_hardship_contexts`
row. Once submitted it's an immutable timeline entry. End-date can
be set on submission, not re-edited. If a tenant needs to amend
context, they file a new context entry.

## What's live (UI)

### Tenant portal — `/credit` (one new inline page)

KPI strip:
- Total events
- On-time payment % (with denominator showing how many payments
  are tracked)
- Current and longest on-time streak

Event timeline:
- Grouped by month, most recent first
- Per row: green/red/grey dot, friendly label, occurred-at date,
  attestation source (e.g. "Stripe (payment processor)"), dimension
  tags, optional `superseded` badge if the event has been replaced
  by a corrected event
- "Dispute" button on negative events that aren't already
  `dispute_*` events themselves

Top-right: "+ Add hardship context" button → modal.

Modals:
- **CreditDisputeModal** — pick reason
  (factual_inaccuracy / attestation_invalid / identity_mismatch /
  other) + optional notes → POST /api/credit/dispute → refresh
- **HardshipModal** — pick category (medical / job_loss /
  family_death / natural_disaster / military_deployment / other) +
  start_date + optional end_date + optional note → POST
  /api/credit/hardship-context → refresh

Nav entry: "📊 My Record" added to the tenant rail under
Inspections + Entry Requests.

## Files touched / created

```
apps/tenant/src/main.tsx     (CreditPage + 2 modals + EVENT_LABEL/POSITIVE_EVENT_TYPES helpers; route + nav added)
```

No backend changes — `/api/credit/subject/own`, `/api/credit/stats/:id`,
`/api/credit/dispute`, `/api/credit/hardship-context` all existed
from S134.

## Validation

- `npx tsc --noEmit -p apps/tenant/tsconfig.json` → exit 0
- `npx tsc --noEmit -p apps/landlord/tsconfig.json` → exit 0 (regression)
- `npx tsc --noEmit -p apps/api/tsconfig.json` → exit 0 (regression)

No live browser smoke. Same gap S136 + S137 left open and now
expanded. Recommended next interactive session: walk all three
flows (inspection, entry-request, credit) end-to-end in dev.

## What this session did NOT do

- **No landlord screening view of a tenant.** A landlord viewing a
  prospective tenant's record (via `/api/credit/subject/:subjectId`,
  visibility-filtered to network/current-landlord only — never
  private events, never the score) is the natural follow-up. Same
  shape as the tenant-own view minus the dispute/hardship buttons,
  visibility-filtered.
- **No admin dispute resolution UI.** Disputes can be opened via
  the tenant flow but resolved only by API calls today
  (`POST /api/credit/dispute/:id/resolve` with admin role). An
  admin tool to list open disputes + resolve corrected/upheld/
  no-change is its own session.
- **No tenant "my disputes" list.** Visible inline today (the
  `dispute_opened` events show up in the timeline) but no
  dedicated index or status tracker. Follow-up.
- **No score-strength banded rendering.** Decision deferred — only
  add this if product feels the tenant needs a directional signal
  beyond on-time-%.
- **No live browser smoke.** All three frontend sessions (S136 +
  S137 + S138) still need an interactive walkthrough.
- **No mobile-responsive tuning.** Tenant tables fall back to
  horizontal scroll; modals are full-screen on small viewports
  via the existing `.modal-ov` styles.

## Pre-launch frontend status

Closed list updates:
- ✅ Tenant credit-ledger dashboard (event timeline, stats, dispute
  open, hardship context)

Open frontend items:
- Live browser smoke (inspection + entry-request + credit flows)
- Landlord screening view (prospective tenant credit record,
  visibility-filtered, no score)
- Admin dispute resolution UI
- Tenant "my disputes" list / status tracker
- Mobile-responsive tuning across all credit-ledger UI
- Notifications integration for dispute lifecycle events

## What next session should target

Three candidates in priority order:

1. **Live browser smoke** — interactive walkthrough of inspection +
   entry-request + credit dashboard. Lowest risk, highest leverage:
   shakes out UX rough edges before more UI piles on.
2. **Landlord screening view** — the visible-events-only counterpart
   to the tenant dashboard. Lets a landlord screening a prospective
   tenant see the network-visible tenancy events. Smaller scope
   than admin tools (no dispute resolution).
3. **Admin dispute resolution UI** — admin lists open disputes,
   reviews evidence, resolves with corrected/upheld/no_change.
   Bigger scope (requires admin event-replacement form for the
   corrected path).

Recommendation: smoke first, then landlord screening view, then
admin dispute resolution.

## Notes for future-Claude

- `EVENT_LABEL` and `POSITIVE_EVENT_TYPES` in tenant main.tsx
  must stay in sync with the formula's positives/negatives keys.
  Adding a new event type to the formula = adding an entry to
  EVENT_LABEL + (if positive) POSITIVE_EVENT_TYPES. Without
  EVENT_LABEL the timeline falls back to the snake_case key,
  which is ugly but not broken.
- The KPI strip uses the lifetime payment slice. If product
  wants a 12-month or 90-day toggle, the `stats.payment_stats`
  shape already has `rolling_12mo` and `rolling_90d` slices —
  swap which one populates the kpi values.
- Dispute modal uses the same `factual_inaccuracy` / `attestation_invalid`
  / `identity_mismatch` / `other` enum as the backend. Adding new
  reasons = update the zod schema in `routes/credit.ts` AND the
  shared CREDIT_DISPUTE_REASONS enum AND this select. Three places.
- The "Dispute" button only shows on tone === 'negative' events.
  If a tenant believes a positive event is incorrect (e.g. a
  rendered on-time payment that they actually didn't make),
  there's no UI path today. That's a real edge case; future
  hardening could allow disputing any event.
- `HardshipModal` requires a start date but the date input doesn't
  set a default. If product wants today's date pre-filled, set
  `useState(() => new Date().toISOString().slice(0, 10))`.
