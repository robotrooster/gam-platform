# Session 154 Handoff

**Theme:** Property-fee-schedule infrastructure shipped. Anti-
discrimination model: per-property standard fee policy that flags
per-lease overrides for audit trail. The original 3C scope
(`other_fee` due_timing picker) expanded into a property-level
architecture per Nic's design call about discrimination risk.

## Decisions captured (this session)

Plain-language design Q+A:

1. **Source of truth for fees** — discrimination risk: landlord
   could write different cleaning fees into different leases on
   the same property. **Locked: hybrid model.** Property has a
   "Standard Fee Schedule" (the policy); leases hold the
   parsed-from-document fee rows (the contract). At lease
   finalize, lease rows are compared to property schedule and
   any divergence is flagged with `is_override=TRUE`.
2. **Properties without a schedule** — Q1 B: allow lease creation
   normally; no enforcement until landlord configures a schedule.
3. **Per-lease overrides** — Q2 B: flag with `is_override` +
   optional `override_reason`. Landlord can fill the reason
   post-finalize via `PATCH /leases/:id/fees/:feeId`. Tenant
   doesn't see the flag; landlord audit log does.
4. **Override use cases** — Nic noted: cleaning fee above
   property-standard would typically reflect documented damage at
   move-in. The `override_reason` field IS that documentation; it
   becomes part of the move-out audit trail when tenants dispute
   deductions (S152 deposit-return surface can read it).

## Items shipped

### Migration: `property_fee_schedules` + lease_fees override columns

```
20260506120000_property_fee_schedules.sql
```

- New `property_fee_schedules` table:
  - `(property_id, fee_type, slot_index)` UNIQUE
  - For single-instance fee types (cleaning_fee, pet_deposit,
    etc.): `slot_index = 0`, only one row per type per property
  - For `other_fee`: multiple `slot_index` values supported, each
    a named variant ("Pool key", "Pet cleaning", etc.) with its
    own description
  - Columns: amount, is_refundable, due_timing (same shape as
    lease_fees)
- `lease_fees` extensions:
  - `is_override BOOLEAN NOT NULL DEFAULT FALSE` — flagged at
    lease finalize when amount/timing/refundable diverges from
    property schedule
  - `override_reason TEXT` — landlord fills post-finalize. UI
    requires it; backend allows blank for legacy rows.

### Routes (in `routes/properties.ts`)

```
GET    /api/properties/:id/fee-schedule          — list rows
POST   /api/properties/:id/fee-schedule          — upsert one row
DELETE /api/properties/:id/fee-schedule/:rowId   — remove
```

Plus in `routes/leases.ts`:
```
PATCH /api/leases/:id/fees/:feeId                — landlord fills override_reason
```

The lease GET endpoint now returns `lease.fees[]` with the override
flag + reason so landlord UI can surface "needs review" badges.

### E-sign integration (audit-trail level)

`routes/esign.ts` `executeOriginalLease` updated. After parsing
fee rows from the lease document (S28+ flow), the function:

1. Loads the property's fee schedule
2. For each lease_fees row being inserted, checks against the
   schedule by fee_type
3. If amount + is_refundable + due_timing all match → `is_override = FALSE`
4. If schedule row exists and any field differs → `is_override = TRUE`
5. If no schedule row exists for that fee_type → `is_override = FALSE`
   (no policy to deviate from)

The lease document is still the legal contract. The schedule is
the policy used for audit-flagging deviations. Future enhancement:
auto-populate the lease document template fields FROM the schedule
at draft time (proactive enforcement instead of post-hoc flagging).

### UI: Standard Fee Schedule editor on PropertyDetailPage

New component `PropertyFeeScheduleSection.tsx` mounted at the
bottom of `/properties/:id`:

- Section 1: "Standard fees" — one row per single-instance
  fee_type (cleaning_fee, pet_deposit, ...19 types). Each shows
  current value or "Not configured" with a Set/Edit button. Edit
  inline expands amount + refundable + due_timing fields.
- Section 2: "Other fees (custom)" — list of `other_fee` variants
  with description. Add row creates a new slot_index. Each row
  is editable inline; trash button removes.

Uses existing `apiPost`/`apiDelete` helpers; integrates with
react-query for cache invalidation on save.

## Files touched / created

```
apps/api/src/db/migrations/20260506120000_property_fee_schedules.sql  (new)
apps/api/src/db/schema.sql                                             (regenerated)

apps/api/src/routes/properties.ts                                      (3 schedule endpoints)
apps/api/src/routes/leases.ts                                          (PATCH fee, GET returns fees[])
apps/api/src/routes/esign.ts                                           (override-flag logic at lease_fees insert)

apps/landlord/src/pages/PropertyFeeScheduleSection.tsx                 (new — 250 lines)
apps/landlord/src/pages/PropertyDetailPage.tsx                         (mounted section)
```

## Validation

- `npm run db:migrate` → 1 applied; schema.sql regenerated to 9661 lines
- `npx tsc --noEmit` on api / landlord / tenant / admin → all exit 0
- Live smoke (3 phases all passing):
  - Phase 1: existing property pick + 4 schedule rows inserted
    (1 cleaning + 1 pet_deposit + 2 other_fee variants) ✓
  - Phase 3: override-flag logic verified inline:
    - cleaning_fee $250 = $250 → is_override=FALSE ✓
    - pet_deposit $350 vs schedule $200 → is_override=TRUE ✓
    - pet_fee with no schedule row → is_override=FALSE ✓
- All test data cleaned

## What this session did NOT do

- **No proactive enforcement at lease creation time.** The
  schedule pre-population would require plumbing into the
  e-sign template builder / lease document field defaults
  pipeline. Today the schedule is the audit-trail target; what
  the doc parser produces is what lands. Discrimination risk is
  reduced (overrides are flagged) but not eliminated (landlord
  could still deliberately set different values per lease).
- **No tenant-facing visibility.** Tenants don't see the
  property schedule or override flags. The flag and reason are
  internal audit data only.
- **No bulk-apply tool** to push schedule changes to existing
  leases. Existing leases are grandfathered (their lease_fees
  rows were locked at signing); only new leases reference the
  current schedule. Intentional — the lease is the contract,
  changing the schedule shouldn't retroactively change anyone's
  signed terms.
- **No override_reason prompt UI** on the landlord lease detail
  page. The PATCH endpoint exists; a follow-up should add a
  banner "X overrides need a reason — click to fill in" on the
  LeaseFormModal or LeasesPage row.

## Pre-launch backend status

Closed list updates:
- ✅ Property fee schedule table + CRUD (S154)
- ✅ E-sign audit-trail flagging of overrides (S154)
- ✅ Landlord UI for managing schedule (S154)
- ✅ This concludes the entire `lease_fees due_timing` wire-up
  backlog. The S144 admin alert that surfaces unbilled
  move_out / other fees still applies as the safety net for
  the doc-parsed billing path.

Remaining open items (unchanged):
- PM third-party-companies subsystem (full build, product input)
- OTP enablement (product call)
- Stripe sandbox testing (test key)
- State-specific tax-form catalog (real session)
- Live browser smoke walkthrough (interactive)
- (New follow-up) Schedule pre-population at e-sign template
  build time + override-reason UI prompt

## What next session should target

The `due_timing` track is closed. Per the ordered backlog from
the start of this conversation, the next item is **OTP
enablement gating**.

OTP (On-Time Pay) qualification gate per CLAUDE.md:
> bg check → deposit → ACH → OTP enrollment

Plain-language design questions ahead:
- Where does the OTP toggle live? Tenant settings? Landlord per-tenant?
- What's the explicit qualification sequence enforced server-side?
- How does FlexPay tier interact (CLAUDE.md flags this as a
  "FlexPay tier UX" gate)?

Then: tax-form catalog (the S91 promise from earlier sessions),
then PM third-party-companies (the big one).

## Notes for future-Claude

- The override-flag logic in `executeOriginalLease` only fires
  on the `original_lease` document type. Addenda
  (`addendum_terms`, etc.) modify lease_fees via different code
  paths — those paths don't currently flag overrides. Follow-up
  consideration when product wants addenda to honor schedules.
- The `override_reason` field is intentionally TEXT not
  required at the DB level. Legacy rows (pre-S154) are all
  `is_override=FALSE` so this isn't an issue. New rows that get
  flagged will have `override_reason=NULL` initially; landlord
  fills post-finalize.
- The S152 deposit-return flow pulls `cleaning_fee` from
  lease_fees at move-out. If that row was an override, the
  landlord's UI on `/leases/:id/deposit-return` could surface
  the override reason as context for the deduction (and tenant
  dispute reviewers could see why $400 was charged instead of
  $250 standard). That linkage isn't yet wired but is a
  natural follow-up.
- `slot_index` on `property_fee_schedules` is always 0 for
  single-instance fee types and 0/1/2/... for `other_fee`. The
  CHECK doesn't enforce this — service layer / UI does. If a
  rogue insert ever creates `(cleaning_fee, slot_index=1)`, the
  e-sign override-flag logic only reads slot 0 via the
  scheduleByType index, so the rogue row is invisible. Acceptable
  for v1; tighten with a CHECK if real-world data shows drift.
