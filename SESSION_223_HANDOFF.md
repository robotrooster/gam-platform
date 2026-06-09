# Session 223 — closed

## Theme

Property-level late-fee policy edit surface. The DEFERRED.md
"Property late-fee edit confirmation modal" item presupposed
an edit surface that didn't exist — schema had 9 late_fee
columns on properties since the initial schema migration but
no UI ever exposed them, no service ever read them. Pure
underwired infra. Per the "Underwired infra is a wiring bug,
not a drop call" memory, the right move was to wire the
consumer surface, not drop the columns.

Option B framing locked: property-level late-fee defines
defaults for new leases at the property; existing leases keep
their current late-fee config (no propagation, no addendum).

## What S223 shipped

### Backend — `apps/api/src/routes/properties.ts`

PATCH `/api/properties/:id` extended with 4 new optional fields:

| Field | Type | Validation |
|---|---|---|
| `late_fee_enabled` | boolean | typeof check |
| `late_fee_grace_days` | integer | finite, ≥ 0 |
| `late_fee_initial_amount` | numeric | finite, ≥ 0 |
| `late_fee_initial_type` | 'flat' \| 'percent_of_rent' | enum guard (matches existing CHECK constraint) |

Same COALESCE($N, col) pattern as the existing fields — pass
the value to update, omit/null to preserve. No POST changes
(create flow uses schema defaults: enabled=true, grace=5,
amount=15.00, type='flat').

### Frontend — `apps/landlord/src/pages/PropertiesPage.tsx`

Form state extended with the 4 fields, prefilled from the
property's camelCased response keys (`lateFeeEnabled`,
`lateFeeGraceDays`, etc).

New "Late-fee policy" block in the Add/Edit modal, visible
**edit-only** (parallel to the create-only Manager Fee block).
Layout:

- Inline notice up top: *"These settings define this
  property's default late-fee policy for new leases. Existing
  leases keep their current late-fee configuration — changes
  here do not propagate retroactively."*
- "Late fees enabled" toggle in the same gold-bordered card
  style as the booking acknowledgment toggle
- 3-column grid below: Grace period (days) / Initial fee /
  Fee type (Flat $ vs % of rent), all disabled when the
  toggle is off (visual + functional dim)

Submit handler converts string inputs to numbers/null and
sends them through `apiPatch('/properties/:id')`. Sends
`undefined` for late-fee fields when not in edit mode so the
create POST doesn't get keys it doesn't accept.

### Files touched (S223)

```
apps/api/src/routes/properties.ts                    (+ 4 late-fee fields on PATCH route, validation, COALESCE update)
apps/landlord/src/pages/PropertiesPage.tsx           (+ form state, + edit-mode UI block, + payload wiring)
```

### Verification

- `cd apps/api && npx tsc --noEmit` → clean
- `cd apps/landlord && npx tsc --noEmit` → clean
- No new migrations — schema columns existed since initial
  schema (with NOT NULL defaults), so a property loaded into
  the form always has values to show

## Decisions made (S223)

| Question | Decision |
|---|---|
| Expose all 9 late-fee columns or just the 4 commonly-used (enabled/grace/amount/type)? | 4. Mirrors what LeaseFormModal currently exposes (only grace_days + initial_amount; the accrual + cap fields are unwired everywhere in the lease UI too). Adding accrual/cap to the property form would create a configuration that lease creation can't even consume. Defer until LeaseFormModal exposes them too. |
| Edit-only or both create + edit? | Edit-only. Matches the Manager Fee block. Schema defaults (enabled=true / 5 / $15 / flat) cover the create case so the landlord doesn't have to make a policy decision at property creation. |
| Where in the form layout? | Between the Booking policy block and the allocation rule block — natural grouping with other "policy decisions" landlord makes for the property. |
| Strict propagation warning copy ("won't affect existing leases") or softer ("for new leases")? | Both. Lead with positive framing ("for new leases") + explicit negative confirmation ("changes here do not propagate retroactively"). The Option B semantic is non-obvious — landlords coming from other PM tools may expect property-level changes to cascade. The two-sentence inline notice eliminates ambiguity. |
| Disable the inputs when `late_fee_enabled` is off, or just visually dim? | Both. `disabled` on the input + `opacity: 0.5` on the grid container. Matches the standard "policy off → its sub-fields are inert" pattern. The values still PATCH (so toggling enabled back on doesn't blow away prior input), they just can't be edited until re-enabled. |
| Backend validation: zod parse like POST, or inline like the existing PATCH? | Inline like the existing PATCH. The PATCH route uses ad-hoc `typeof` / undefined checks throughout (booking ack, address fields, etc); adding a partial zod schema for just these 4 fields would be inconsistent. The inline validators (finite + non-negative + enum-guard) cover the relevant cases. |

## Carry-forward — S224+

### LeaseFormModal default-pull (the deferred Option B half)

The half-session I explicitly carved out at scope-shaping time.
LeaseFormModal currently hardcodes `lateFeeGraceDays: '5'` and
`lateFeeInitialAmount: '15.00'` (lines 67-68, 89-90). To
complete the wire-up:

1. When the unit selector picks a unit, fetch that unit's
   property and seed the late-fee inputs from
   `property.lateFeeEnabled / lateFeeGraceDays /
   lateFeeInitialAmount / lateFeeInitialType`. Landlord can
   still override per-lease.
2. Show a small "(from property: $X)" hint on the input when
   the value matches the property default — disappears once
   landlord overrides.
3. Decide: should the hint stay even when overridden ("(was
   $X from property)") or vanish? Probably vanish — clutter
   otherwise.
4. The lease form only exposes 2 of 4 fields. Either expose
   the other 2 (`late_fee_initial_type`, `late_fee_enabled`)
   or document that the other 2 silently inherit from the
   property at lease creation. Product call.

Half-session, no schema changes, single file. Unblocks the
"property defaults actually flow into leases" promise of
this session's UI.

### Property accrual + cap fields

Lease form exposes none of these. Once LeaseFormModal exposes
them at the lease level, the matching property-level fields
(`late_fee_accrual_amount/type/period`,
`late_fee_cap_amount/type`) can be wired into the property
edit form using the same pattern. Defer until LeaseFormModal
catches up.

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

End of S223 handoff.
