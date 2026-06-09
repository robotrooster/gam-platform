# Session 140 Handoff

**Theme:** Landlord-side tenant screening view. Read-only window
into a prospective or current tenant's GAM behavioral record.
Closes one of the two remaining UI pieces on the credit-ledger
track.

## Architecture decisions (this session)

### One round-trip endpoint for screening

Added `GET /api/credit/screening-by-tenant/:tenantId` which:
- Resolves `tenants.id` to its `credit_subjects.id` internally.
- Returns visibility-filtered events + the latest stats panel in
  one payload.
- Returns an empty payload (not 404) when the tenant has no ledger
  activity yet, so the UI can render a clean "no record yet" state
  without special-casing the not-found case.

The existing `/subject/:subjectId` endpoint still works; the new
one is a convenience for the landlord screening UI which
doesn't know the subject_id and shouldn't have to do a two-step
lookup.

### Score is intentionally not in the screening payload

Same locked rule as the tenant dashboard. Landlords see events +
stats; never the composite. The UI surfaces an Info banner stating
the policy directly so the landlord understands the mental model
("decide on the events, not a number").

### Visibility math is server-side only

The frontend doesn't know the requester-to-subject relationship.
Backend `canViewSubject()` returns the allowed tier list and the
event chain is filtered before serialization. This means the
landlord can't accidentally see private events even if they
introspect network requests — there's no oversharing to filter
out.

## What's live (UI)

### Landlord portal — `/screening`

- Search box → live filter over the landlord's tenants (and active
  unit occupants) by name or email
- Click a result → fetch screening payload → render KPI strip +
  event timeline (read-only)
- KPI strip: visible events, on-time %, current/longest streak
  (all from the stats panel)
- Each event row shows the dot tone (green/red/grey), label,
  occurred date, and a visibility badge (`network` vs `current
  relationship`) so the landlord understands which tier of
  visibility opened that event up
- "Pick a different tenant" button to clear and search again

Nav entry "Tenant Record" added under the Screening section
between Background Checks and the existing Applicant Pool.

## Files touched / created

```
apps/api/src/routes/credit.ts                                  (new screening endpoint)
apps/landlord/src/pages/TenantScreeningPage.tsx                (new)
apps/landlord/src/main.tsx                                     (route)
apps/landlord/src/components/layout/Layout.tsx                 (nav entry)
```

No database migrations. No tenant changes. No emitter changes.

## Validation

- `npm run build` in `packages/shared` → clean
- `npx tsc --noEmit -p apps/landlord/tsconfig.json` → exit 0
- `npx tsc --noEmit -p apps/tenant/tsconfig.json` → exit 0 (regression)
- `npx tsc --noEmit -p apps/api/tsconfig.json` → exit 0 (regression)
- Live smoke against dev DB:
  - Synthesized a 3-event chain (one current-landlord-visible,
    one network-visible, one private)
  - Confirmed admin/super_admin sees all 3 ✓
  - Confirmed current-landlord-relationship visibility filter
    yields 2 ✓
  - Confirmed network-only visibility filter yields 1 (the NSF) ✓
  - Cleanup verified

## What this session did NOT do

- **No live browser smoke.** Same gap. With the screening view in
  place, the next interactive walkthrough should hit all three
  UIs (inspection / entry-request / credit-tenant + screening).
- **No prospective-tenant import flow.** The screening picker
  only lists tenants the landlord has already invited or has on
  file. To screen a brand-new applicant before invite, you need
  their tenant_id first — which means inviting first, then
  screening. Landlord-portal "import applicant for screening"
  flow is its own session.
- **No score export / report PDF.** Some landlords will want a
  printable record. Not built.
- **No bulk screening.** The screening view is one tenant at a
  time. No "compare three applicants" surface.
- **No mobile-responsive tuning.** Same gap as the other UI
  sessions.
- **No admin dispute resolution UI yet.** Last remaining UI piece
  on the credit-ledger track. Next session.

## Pre-launch frontend status

Closed list updates:
- ✅ Landlord screening view (read-only, visibility-filtered)

Open frontend items:
- Live browser smoke walkthrough across all credit-ledger UI
- Admin dispute resolution UI (last remaining piece)
- Prospective-tenant import for pre-invite screening
- Mobile-responsive tuning
- Notification preferences UI

## What next session should target

Two reasonable paths:

1. **Live browser smoke walkthrough** (interactive, highest leverage,
   low risk) — exercise inspection / entry-request / tenant-credit
   / landlord-screening end-to-end, confirm notifications fire
   between portals, verify cron-driven events would land.
2. **Admin dispute resolution UI** — last UI piece. Lists open
   disputes, lets admin review evidence + resolve with
   upheld/no_change/corrected (the corrected path needs an
   event-replacement form). Bigger scope than this session.

Recommendation: smoke walkthrough first. Real interactive feedback
will probably surface 2-3 small UX rough edges that are cheaper to
fix before the admin UI lands on top of the same patterns.

## Notes for future-Claude

- `EVENT_LABEL` and `POSITIVE_EVENT_TYPES` are duplicated in
  `apps/landlord/src/pages/TenantScreeningPage.tsx` and
  `apps/tenant/src/main.tsx`. Acceptable copy because the two
  apps don't share a UI library; if the formula adds new event
  types, both copies must be updated. Future cleanup: move to
  `packages/shared` as a UI-side helper module.
- The screening picker pulls the union of unit occupants
  (`/units` joined by `tenantId`) AND the bare tenants list
  (`/tenants`). Tenants without an active unit show with their
  email as the sub-label. If a landlord has thousands of
  off-platform tenants this might get heavy; pagination is a
  follow-up.
- The screening payload includes the latest `credit_stats` row.
  Stats are refreshed nightly by the credit-nightly cron. A
  brand-new screening lookup against a tenant who's never had a
  nightly run yet will return `stats: null` — the UI handles
  that (shows `—` for percentages).
- Visibility tier badge ('network' vs 'current relationship') on
  each event row uses the *event's* network_visibility, not
  whether the requester has the relationship. So a landlord with
  an active relationship to the tenant will see network-tier
  events too, but they're correctly badged as 'network' so the
  landlord knows that event would have been visible regardless.
