# Session 478 — closed

> Tenant-side surfacing of S475/S476/S477 entry-request warnings.
> Closes the both-party transparency loop.

## Theme

**The hedged factual warnings that landlords saw at entry-
request submit time (S475 outside-typical-hours + S476
state-law mismatch) now also reach the tenant on the request
detail page. To make that work without persisting warnings on
the row (which would freeze them at create time), GET /:id
recomputes against the persisted notice_window_hours and
proposed_entry_window_start. The compute path is extracted as a
single helper so POST and GET share one source of truth. Tenant
page renders both warning blocks above the response form.**

Suite (api) at S477 close: 3049 / 160.
Suite (api) at S478 close: **3051 / 160 / 0 failures** (+2
S478 GET-warning cases).

apps/tenant tsc: clean. apps/tenant build: clean.

## What shipped

### `apps/api/src/routes/entryRequests.ts`

**Extracted `computeEntryRequestWarnings()` helper:**

```ts
async function computeEntryRequestWarnings(args: {
  unitId: string
  startIso: string
  noticeWindowHours: number
}): Promise<{
  outsideTypicalHours: boolean
  typicalHoursWarning: string | null
  stateLawWarnings: LawFlag[]
}>
```

- One SQL hit to pull timezone + local_hour + state from
  units → properties.
- 8 AM/8 PM bracket check on the computed local_hour.
- Hedged typical-hours copy when outside.
- `checkAgainstStatute('entry_notice_hours', noticeWindowHours)`
  when the state has a catalogued provision.
- NEVER throws. Returns safe defaults `{ false, null, [] }` on
  any DB or engine failure; logs the error.

POST `/` was 40 lines of inline compute; now it's:
```ts
const warnings = await computeEntryRequestWarnings({
  unitId: body.unitId,
  startIso: start.toISOString(),
  noticeWindowHours,
})
```

GET `/:id` now also calls the helper, using the persisted
row's `unit_id`, `proposed_entry_window_start`, and
`notice_window_hours`. Attaches `outside_typical_hours` +
`typical_hours_warning` + `state_law_warnings` to the
response data alongside the existing `response` field.

**Why recompute instead of persist:**
- Single source of truth — the engine's current view of state
  law, not a frozen snapshot from create time.
- When the quarterly refresh ships, warnings auto-update on
  next GET (no backfill).
- Cost is one SQL + one provisions lookup per detail GET —
  negligible.
- Outside-typical-hours is a pure function of (start, timezone)
  — recomputing always yields the same answer; no drift.

### `apps/tenant/src/main.tsx` — `TenantEntryRequestDetailPage`

Added two inline blocks between the entry detail card and the
response card:

1. **Outside-typical-hours notice** — amber-themed card with
   the server-provided `typicalHoursWarning` copy, gated on
   `outsideTypicalHours: true`.
2. **State-law warnings list** — amber-themed card listing
   each LawFlag with the hedged message, statute citation,
   external "source" link, dated "as of" line, and the GAM
   disclaimer rendered as italic small text.

Both blocks use the tenant portal's own CSS tokens
(`--t0..--t3`, `--amber`) — not the landlord
`LawWarningBanner` component, since the token names differ
and pulling a shared component cross-portal would mean a new
package. Inline duplication is cheaper at this scale.

### Tests — 2 new cases on `entryRequests.test.ts`

```
S478: tenant GETs own request → sees outside_typical_hours + state_law_warnings
S478: GET on a within-range request → outside_typical_hours=false + empty state_law_warnings
```

The first case constructs a request with both flags firing
(30h notice from now + a 5 AM Phoenix local-hour start) then
asserts the tenant's GET returns both `outside_typical_hours:
true` and a non-empty `state_law_warnings` array with the
`entry_notice_hours` topic. The second pins the
within-range path: 60h notice + 10 AM Phoenix start, both
fields clean.

Existing S475/S476 POST-side tests stay green — the response
shape is unchanged (POST still returns the same fields via
the helper).

## Items shipped

```
apps/api/src/routes/
  entryRequests.ts                             (extract helper + GET attaches warnings)
  entryRequests.test.ts                        (+2 S478 GET cases + reused seed helper)
apps/tenant/src/
  main.tsx                                     (TenantEntryRequestDetailPage banners)
```

## Decisions made during build

| Question | Decision |
|---|---|
| Persist warnings on the row or recompute on GET | **Recompute.** Persisting would freeze the snapshot at create time and drift from the catalog after quarterly refreshes. Recompute keeps the warning current. Cost is negligible. |
| Share LawWarningBanner cross-portal | **No, inline duplicate on tenant side.** Landlord uses `--text-0..-3` / `--border-0..-2`; tenant uses `--t0..--t3` / `--b0..--b2`. Same component would need conditional theming or a shared package. The banner is ~50 lines of JSX; duplicate is cheaper than a new package. |
| Render outside-typical-hours via the same LawWarningBanner pattern | **No, separate card.** Outside-typical-hours isn't a LawFlag — no citation, no source URL, no source date. Rendering it through the LawFlag shape would require fake/null fields. Kept as a distinct hedged-amber card with its own header. |
| Place the warnings above or below the entry detail card | **Above the response card, below the detail.** The detail describes *what the landlord proposed*; the warnings describe *how it stacks up*; the response is *what the tenant does about it*. Natural reading order. |
| Surface to the tenant LIST page too | **No, detail only.** List view is for triage; warnings are decision-supporting context that fit on the detail page. List would clutter. |
| Helper function placement: inside the route file or new service module | **Inside the route file.** Single consumer (this route's POST + GET); promoting to a service for one file's worth of consumers is premature. |
| Best-effort vs throw on compute failure | **Best-effort with logger.error.** Never block the GET on a warning compute failure — the user still wants the request data. |
| Warnings on the LIST endpoint | **No.** Same rationale as not putting them on the LIST page. List response stays minimal. |

## Verification

- `cd apps/api && npx tsc --noEmit`: clean.
- `cd apps/tenant && npx tsc --noEmit`: clean.
- Targeted: `vitest run src/routes/entryRequests.test.ts` —
  24 passed (22 prior + 2 S478).
- Full: `npm test` from apps/api — **3051 / 160 / 0 failures**
  (+2 from S477).
- `cd apps/tenant && npm run build`: clean (pre-existing 500
  KB chunk warning, unrelated).
- **Browser walk deferred** — full end-to-end walk would be
  landlord creates AZ entry-request with 24h notice, tenant
  logs in and sees both warning blocks on the request detail.

### Bugs caught during build

None.

## Phase status

The state-law write-path arc is now both-party closed:

- **Landlord write paths** (S476): lease PATCH + entry-request
  POST return `state_law_warnings`. Landlord UI (S477) renders
  banners on save.
- **Tenant read paths** (S478): entry-request GET recomputes
  warnings; tenant UI renders the same hedged notices.

Lease detail surface on the tenant side (S210
AddendumHistorySection territory) would be the natural
extension if state-law warnings on a tenant's lease detail
make sense — but lease terms set by landlord don't materially
change once a tenant has signed, so the value would be
marginal.

## What the next session should target

Remaining candidates:

- **Quarterly-refresh cron** for state law KB (open since
  S475). Admin notification when any provision's
  `source_date` is older than 90 days. Small backend.
- **Promote `STATE_LAW_TOPICS` to `packages/shared`** — now
  that two distinct UIs (landlord LawWarningBanner + tenant
  inline blocks) consume the LawFlag shape, the topics map
  could move to shared if topic-aware UI (icons, labels)
  becomes useful. Hold for now since neither UI imports it
  directly.
- **Landlord performance dashboard + agent-log report view**
  (still open from S475).
- **Other write paths** that don't yet check state law:
  - Lease fee PATCH on `/leases/:id/fees/:feeId` (S476
    only wired the parent lease PATCH; per-fee edits go
    through a different endpoint).
  - Property-default settings (entry notice default,
    late-fee defaults) — landlords set baseline values
    that propagate to new leases.

Strong recommend: **quarterly-refresh cron**. Small, closes a
named memory item, and aligns with the launch-readiness
posture (it's the operational discipline that keeps the KB
live).

---

End of S478 handoff. **Tenant-side surface shipped. Both-party
transparency loop closed: landlord sees warnings on submit,
tenant sees the same warnings on detail load (recomputed, so
they stay current as the catalog refreshes).**

3051 tests / 160 files / 0 failures.

**State-law write-path arc end-to-end functional.** Quarterly
refresh cron is the natural next operational closure.
