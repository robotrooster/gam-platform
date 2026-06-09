# Session 224 — closed

## Theme

LeaseFormModal default-pull from property — the deferred Option B
half called out in S223 carry-forward. Recon flipped two
assumptions in the original carry-forward and surfaced a
pre-existing form bug that got fixed in the same pass.

## Recon findings (before any code)

1. **Backend lease PATCH did not accept `lateFeeEnabled` or
   `lateFeeInitialType`.** `apps/api/src/routes/leases.ts:336+`
   zod schema and the addendum-diff comparator only knew about
   `lateFeeGraceDays` + `lateFeeInitialAmount`. Honoring Q1=(b)
   from S223 (expose all 4 fields) required extending the PATCH
   route too. Done.

2. **There is no `POST /api/leases` route at all.** `LeaseFormModal`
   create-mode submits `apiPost('/leases', data)` → 404. The
   "Add Lease" button on `LeasesPage` has been broken; live
   creation paths are e-sign (`esign.ts:493`), CSV import
   (`landlords.ts:747`), and lease parser
   (`leaseParser/resolveIntent.ts:181`). Pre-existing bug. **Not
   fixed in S224.** Carried forward — see below.

3. **LeaseFormModal had a silent UI bug:** every `onChange` handler
   called `set('snake_case_key', val)` while the form state and
   inputs use camelCase keys. `set` writes literally — so user
   edits created stray snake_case keys on form state and the
   inputs (reading from camelCase keys) snapped back to their
   defaults. Combined with #2, the entire Add/Edit Lease
   workflow has been effectively read-only for some unknown
   span of time (likely since S23a's "API camelCase boundary
   refactor" left these handlers stale). **Fixed in S224 per
   fix-it-right** — all 12 onChange handlers in this file now use
   camelCase keys matching the form state.

## What S224 shipped

### Backend — `apps/api/src/routes/leases.ts`

PATCH `/api/leases/:id` extended:

| Change | Lines (approx) |
|---|---|
| Added `lateFeeEnabled: z.boolean().optional()` to zod schema | ~352 |
| Added `lateFeeInitialType: z.enum(['flat','percent_of_rent']).optional()` to zod schema | ~353 |
| Both fields treated as **non-material** in the S201/S202 addendum gate (consistent with where `late_fee_grace_days` and `late_fee_initial_amount` already live) | ~440-450 |
| Added `late_fee_enabled` + `late_fee_initial_type` to the SQL field map | ~510-513 |

Non-material changes flow through the existing addendum
confirmation flow → PDF generation → credit-ledger event
emission. No new code paths; just two more fields on the
existing rails.

### Shared — `packages/shared/src/index.ts`

`ADDENDUM_DIFF_FIELD_LABEL` extended with two entries:
- `late_fee_initial_type: 'Late fee type'`
- `late_fee_enabled: 'Late fees enabled'`

`formatAddendumDiffValue` extended to humanize the new fields
in the diff display:
- `late_fee_initial_type`: `flat` → 'Flat $', `percent_of_rent` → '% of rent'
- `late_fee_enabled`: `true` → 'Yes', `false` → 'No'

Used by both LeaseFormModal's in-modal addendum confirmation
overlay AND the API's `addendumPdf.ts` generator.

### Frontend — `apps/landlord/src/pages/LeaseFormModal.tsx`

1. Form state extended with `lateFeeEnabled: boolean` +
   `lateFeeInitialType: 'flat' | 'percent_of_rent'`.
2. Edit-mode hydration pulls both new fields from
   `existingLease`.
3. Add useQuery for the selected unit's property
   (`/properties/:id`), keyed off `selectedPropertyId` derived
   from the units list.
4. Add useEffect: in **create mode only**, seed the late-fee
   inputs from the property's defaults the first time a unit is
   picked for a given property (tracked via `seededForPropertyRef`).
   Edit mode skips — the existing lease's saved values win.
5. **"(from property)" hint** appears next to each late-fee
   input whenever the form value matches the property's default;
   vanishes once the landlord overrides (Q2=(b) from S223 scope).
6. Late-fees section rewritten:
   - Top: "Late fees enabled" toggle (with hint)
   - Below: 3-column grid (grace / amount / type), all dimmed
     and disabled when toggle is off
7. Add `lateFeeEnabled` + `lateFeeInitialType` to PATCH payload.
8. **Bonus fix:** all 12 onChange handlers switched from snake_case
   to camelCase keys, restoring the form's editability. See recon
   #3.

### Files touched (S224)

```
apps/api/src/routes/leases.ts                        (+ 2 zod fields, + 2 diff comparators, + 2 SQL field-map entries)
packages/shared/src/index.ts                         (+ 2 label entries, + enum/boolean humanization in formatAddendumDiffValue)
apps/landlord/src/pages/LeaseFormModal.tsx           (+ form state, + property useQuery, + create-mode seed effect, + 4 hint helpers, + LATE FEES UI rewrite, + FIELD_LABEL entries, + 12 onChange snake→camel fix)
```

### Verification

- `cd packages/shared && npm run build` → clean
- `cd apps/api && npx tsc --noEmit` → clean
- `cd apps/landlord && npx tsc --noEmit` → clean
- No new migrations
- Every existing addendum consumer (`addendumPdf.ts`,
  `LeaseFormModal` overlay, tenant `LeasePage`) reads from the
  shared label map, so the two new fields show up correctly
  everywhere on first deploy.

## Decisions made (S224)

| Question | Decision |
|---|---|
| All 4 late-fee fields in LeaseFormModal, or 2? | All 4 (S223 Q1=(b)). Hidden inheritance on type/enabled was rejected — a property set to `percent_of_rent` shouldn't silently overwrite a lease's flat-implied $15 amount. |
| "(from property)" hint stays after override or vanishes? | Vanishes (S223 Q2=(b)). Override = intentional, no tombstone clutter. |
| Treat `lateFeeEnabled` / `lateFeeInitialType` as material or non-material in the S201 gate? | **Non-material.** Consistent with where `late_fee_grace_days` + `late_fee_initial_amount` already live. Triggers addendum confirmation + PDF + credit event, doesn't block as material. The product framing: rent and term are material; late-fee policy is non-material across all 4 sub-fields. |
| Fix the snake/camel `set()` bug in this pass, or defer? | **Fix.** Single file, mechanical, ~12 string substitutions, and not fixing would have meant my new late-fee inputs would silently fail too. Per fix-it-right + the underwired-infra memory: when a consumer surface is broken, wire it correctly. |
| Build the missing `POST /api/leases` route? | **No.** Out of scope for a half-session and needs product calls about whether create-mode lease creation should bypass the e-sign workflow at all (probably not — but there are admin/CSV-style cases). Carried forward. |
| In create mode, seed inputs from property even though POST is dead? | **Yes.** Cheap, dormant, and ready for whenever POST `/leases` comes online. The `seededForPropertyRef` only fires once per property selection so re-clicking the same unit doesn't blow away an in-progress override. |

## Carry-forward — S225+

### POST `/api/leases` route does not exist (pre-existing — newly surfaced)

The "Add Lease" button on LeasesPage opens LeaseFormModal in
create mode. Submit calls `apiPost('/leases', data)` which 404s
because no `POST /` exists on `leasesRouter`.

Live lease-creation paths today:
- E-sign workflow: `esign.ts:493` `INSERT INTO leases` after both
  parties sign
- CSV import (landlord): `landlords.ts:747` bulk import path,
  marks rows `needs_review=true`
- Lease parser: `leaseParser/resolveIntent.ts:181` — paste-text
  intent flow

The "Add Lease" landlord direct-create button has no backend.
Two product calls before building:

1. **Should this button exist at all?** If e-sign is the
   one true creation path (common in modern PM stacks), the
   button could be removed in favor of "Start tenant onboarding."
2. **If yes:** `POST /api/leases` needs to wrap an `INSERT INTO leases`
   + `INSERT INTO lease_tenants` + `INSERT INTO lease_fees` (move-in,
   security deposit) in one transaction, decide whether the lease
   starts in `pending` or `active` status, and probably emit a
   credit-ledger event for the tenant. Not trivial — full
   half-session at minimum.

Recommend deferring until Nic decides #1.

### Property accrual + cap fields

Same as carried over from S223: `late_fee_accrual_amount/type/period`
+ `late_fee_cap_amount/type` columns exist on `properties` and on
`leases` but no UI exposes them on either. When LeaseFormModal
exposes them at the lease level, the matching property edit-form
fields can be wired with the same pattern S223 used.

### Already-known carry-forward (unchanged)

- POS thread polish — `pos_items.category → FK to pos_categories.id`
  refactor + `(landlord_id, name)` UNIQUE on pos_categories
- Wire `pos_tax_rates` → cart math (S217 carry — needs
  product call on stacking + override semantics)
- Sublease phase 3 (multi-session greenfield)
- Stripe Connect S113 rebuild (multi-session)
- DEFERRED.md "Build sessions" tombstone trim (mechanical
  hygiene, full session)
- 4 npm audit vulns (deferred to dedicated upgrade sessions)
- Platform-specific CSV import mappings
- Tenant-pool picker + unit picker with consent rule
- End-to-end /resolve smoke
- Landlord disbursement engine that nets tenant-owed deposit
  interest from monthly payouts (separate from the lease-end
  netting which IS wired)
- Primary manager urgency tier (S185 — needs Nic input)
- Owner-financial-escalation pattern (S186 — needs Nic input)
- D2 Flex tenant suite (launch-flag gated)
- F1 Marketing rebuild
- POS Terminal hardware

---

End of S224 handoff.
