# Session 486 — closed

> Property detail page state-law warnings on read. Mirrors the
> S483 tenant LeasePage pattern for the landlord's property
> view.

## Theme

**Landlord PropertyDetailPage now shows the same hedged
factual state-law warnings the PropertiesPage modal renders
on save (S481). GET `/api/properties/:id` recomputes against
the persisted property defaults via the existing
`checkLeaseAgainstStateLaw` helper (deposit check skips
naturally — no per-property rent figure), and the detail
page renders the existing landlord `LawWarningBanner` above
the stats card. So a landlord who walks back to a property
weeks later and reviews its config sees any current-state
mismatch without having to re-trigger the edit modal.**

Suite (api) at S485 close: 3084 / 164.
Suite (api) at S486 close: **3087 / 164 / 0 failures** (+3
S486 cases on `properties.test.ts`).

apps/api tsc: clean. apps/landlord tsc: clean. landlord
build: clean.

## What shipped

### `apps/api/src/routes/properties.ts` — `GET /:id`

Extended from one-line SELECT to also call
`checkLeaseAgainstStateLaw` with property fields:

```ts
stateLawWarnings = await checkLeaseAgainstStateLaw({
  stateCode:            p.state,
  rentAmount:           null,  // no per-property rent figure
  lateFeeInitialAmount: p.late_fee_initial_amount,
  lateFeeInitialType:   p.late_fee_initial_type,
  lateFeeGraceDays:     p.late_fee_grace_days,
})
```

The helper's `rentAmount: null` skips the deposit check (which
requires `rentAmount > 0`). Only the late-fee checks fire —
matches the S481 property PATCH posture. Returned as
`data.state_law_warnings: LawFlag[]`.

Best-effort: try/catch logs on failure, GET success unaffected.

### `apps/api/src/routes/properties.test.ts`

3 new cases:
- NV property with 10% percent-of-rent default (above 5% NRS
  118A.210 cap) → flag fires on GET (proves recompute works
  post-PATCH).
- AZ property with 10% percent-of-rent → empty (AZ residential
  has no `late_fee_max_pct` provision; uncatalogued topic
  correctly returns empty).
- Flat-dollar late fee → empty (no percent check fires; not
  comparable to a percent cap).

Inline `seedNvLateFeeCap()` helper since schema.sql is
schema-only — same pattern used in earlier state-law tests.

### `apps/landlord/src/pages/PropertyDetailPage.tsx`

- Imports the existing `LawWarningBanner` component (built
  S477).
- `<LawWarningBanner warnings={property.stateLawWarnings} />`
  inserted between the page header and the stats grid.
  Banner is empty-state-aware (returns null when array is
  empty/null), so insertion is unconditional and clean.

## Items shipped

```
apps/api/src/routes/
  properties.ts                                (GET /:id attaches state_law_warnings)
  properties.test.ts                           (+3 S486 cases + seed helper)
apps/landlord/src/pages/
  PropertyDetailPage.tsx                       (+ LawWarningBanner)
```

## Decisions made during build

| Question | Decision |
|---|---|
| Persist warnings on property row or recompute on GET | **Recompute.** Same posture as S478 / S483 — the catalog refreshes quarterly; recompute keeps current. |
| Reuse `checkLeaseAgainstStateLaw` or build a property-specific helper | **Reuse.** The lease helper already supports optional inputs; passing `rentAmount: null` cleanly skips the deposit check. Building a parallel helper for the late-fee subset would be ceremony. |
| Banner placement on the detail page | **Above the stats grid, below the page header.** Same vertical position pattern as the tenant LeasePage S483 work; warnings sit between identification and content. |
| Reuse the landlord `LawWarningBanner` component | **Yes.** Same portal, same token namespace. Built S477 with this exact use case in mind. |
| Render even when empty | **No — component handles its own empty state.** `LawWarningBanner` returns null when `warnings` is null/empty/undefined. Unconditional mount stays clean. |
| Add per-field click-to-edit behavior | **No.** Detail page is read-only context; edit is via the existing PropertiesPage modal. Click-through would conflict with the existing entry points. |

## Verification

- `cd apps/api && npx tsc --noEmit`: clean.
- `cd apps/landlord && npx tsc --noEmit`: clean.
- Targeted: `vitest run properties.test.ts` — 24 passed (21
  prior + 3 S486).
- Full: `npm test` — **3087 / 164 / 0 failures** (+3 from
  S485).
- `cd apps/landlord && npm run build`: clean (pre-existing
  500 KB chunk warning unrelated).

### Bugs caught during build

None.

## Phase status — state-law surface map

| Surface | Backend wiring | UI |
|---|---|---|
| Lease PATCH | S476 → S483 (helper) | S477 LeaseFormModal banner |
| Property PATCH | S481 | S481 PropertiesPage modal banner |
| **Property GET /:id (recompute)** | **S486 (helper reuse)** | **S486 PropertyDetailPage banner** |
| Tenant GET /lease (recompute) | S483 (helper) | S483 LeasePage banner |
| Entry-request POST | S475 + S476 | S477 NewEntryRequestPage |
| Entry-request GET (recompute) | S478 (helper) | S478 tenant inline blocks |
| Refresh discipline | S479 weekly cron | — |
| Landlord reporting | S480 VIEW + routes | S480 page + S482 dash card |
| PM-company reporting | S484 PM-scoped routes | S484 dash card + S485 page |

**Every directional-figure write path now warns the actor on
submit AND the affected party on read.** Refresh discipline
+ both-portal reporting layered on top.

## What the next session should target

Remaining open candidates:

- **Mobile-responsiveness audit** on the new amber banners +
  KPI cards. Should reflow on phone-sized viewports.
- **New product arcs** needing direction — website hosting,
  listings build-out, property-intel build-out.
- **Edge surfaces** — tenant might also see warnings when
  reading their own unit detail / property's posted listings.
- **Take stock and plan a new arc** if direction needed.

No strong single recommend — the state-law arc is at
structural completion across read + write paths and across
all relevant portals.

---

End of S486 handoff. **Property detail page state-law
warnings shipped. Last well-defined read surface in the
state-law arc closed.**

3087 tests / 164 files / 0 failures.

**State-law arc structurally complete across read + write
paths on all three portals (landlord / tenant / PM company).**
