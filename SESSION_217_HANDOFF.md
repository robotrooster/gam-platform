# Session 217 — closed

## Theme

Per-property POS tax rates. Same property-scoping pattern as
S192's pos_items. Continues the POS property-scoping thread
started in S216.

## What S217 shipped

### Migration — pos_tax_rates.property_id

`apps/api/src/db/migrations/20260509161947_pos_tax_rates_property_id.sql`:

- `pos_tax_rates.property_id` uuid REFERENCES properties(id) ON
  DELETE SET NULL.
- Partial index `idx_pos_tax_rates_property ... WHERE property_id
  IS NOT NULL` (NULL property_id = legacy landlord-wide; index
  only the per-property rows).
- COMMENT spells out: NULL = landlord-wide library, non-NULL =
  property-scoped library; forward-looking note on cart math.
- No backfill — existing rows stay landlord-wide.

### Backend — `/api/pos/tax-rates` honors property_id

`apps/api/src/routes/pos.ts`:

- **GET `/tax-rates`** — optional `?propertyId=` filter mirrors
  S192's pos_items shape: returns rates at that property UNION
  landlord-wide rates with NULL property_id. Without filter,
  returns all rates for configuration management.
- **POST `/tax-rates`** — accepts optional `propertyId`.
  Validates ownership before INSERT (same pattern as
  pos_items). NULL accepted (legacy landlord-wide posture).
- **PATCH `/tax-rates/:id`** — null clears property_id, undefined
  preserves, uuid re-assigns. Re-assignment validates ownership.

### Frontend — POSPage taxes tab

`apps/pos/src/pages/POSPage.tsx`:

- **Add Tax Rate form** — new Property selector spanning two
  grid columns. Empty default = landlord-wide.
- **Filter dropdown** above the rates list, mirroring S216's
  items-tab filter. Each option shows count: "All (N) /
  Landlord-wide (N) / <Property Name> (N)".
- **Property column** in the rates table between Type and Rate.
  Items with `propertyId` set render the property name in gold;
  NULL render "Landlord-wide" in muted italic.
- Filter logic: `'all'` / `'landlord-wide'` / property uuid —
  same predicate shape as items tab.

### Note on cart math

The POS cart math computes taxes from each item's per-item
`taxRate` field, NOT from `pos_tax_rates`. The pos_tax_rates
table is a configuration library the landlord manages but the
sale flow doesn't currently consume. So this session is
forward-looking infrastructure: schema lands now, a future
session can wire the cart to consume property-scoped rate
definitions (e.g. apply state sales tax automatically based on
the property the sale is at). Documented in the migration
COMMENT.

### Files touched (S217)

```
apps/api/src/db/migrations/20260509161947_pos_tax_rates_property_id.sql  (NEW — column + index + comment)
apps/api/src/db/schema.sql                                               (regenerated)
apps/api/src/routes/pos.ts                                               (GET filter, POST/PATCH validate, ownership checks)
apps/pos/src/pages/POSPage.tsx                                           (newTax.propertyId state, filter dropdown, Property column, form selector)
```

### Verification

- `npm run db:migrate` → applied; schema.sql regenerated
- `psql gam -c "\d pos_tax_rates"` → property_id column + FK + partial
  index present
- `cd apps/api && npx tsc --noEmit` → clean
- `cd apps/pos && npx tsc --noEmit` → clean

## Decisions made (S217)

| Question | Decision |
|---|---|
| Backfill existing rates to a property? | No. Same posture as S192's pos_items — pre-S217 was "applies landlord-wide" semantic; we don't know which property a rate should belong to without product input. NULL preserved as legacy posture; landlord can re-assign via the existing PATCH path. |
| ON DELETE behavior on the property_id FK? | SET NULL. Same pattern as pos_items. If a property is deleted, its tax rates revert to landlord-wide rather than being orphaned/deleted — consistent with the "items survive their context" philosophy. |
| Wire pos_tax_rates into the cart math now? | No. Out of scope. Cart math currently uses per-item `taxRate` field. Wiring rate-table → cart is a separate product call (which rates apply to which items? state sales tax automatically? landlord override?) and a separate session. |
| GET endpoint filter semantics — strict scope or property+landlord-wide UNION? | UNION. Same as S192's pos_items: a property-scoped query should also see landlord-wide entries (those apply at every property by definition). Strict scope would hide landlord-wide rates and force callers to make two queries. |
| Same filter+column pattern as items tab? | Yes. Cohesive UX across POS tabs reduces cognitive load. Filter dropdown reads identically; Property column renders identically (gold name or muted "Landlord-wide" italic). |

## Carry-forward — S218+

### POS property-scoping thread (continuing)

- **pos_categories** — STILL underwired (no frontend consumer).
  Path forward: replace POSPage's hardcoded `CATEGORIES` constant
  with a fetched list, surface "Manage Categories" UI, then
  decide property scoping. Skipped in S216, still skipped in
  S217. Half-to-full session when ready.
- **pos_discounts** — could go either way (per-property promos
  vs landlord-wide). Defer until product call.
- **pos_vendors** — likely stays landlord-wide (vendors often
  serve multiple properties). Defer until product call.

### Future cart-math wiring

Cart currently uses `item.taxRate` directly. Wiring `pos_tax_rates`
table into the cart math would:
- Let landlords define a single "AZ State Sales Tax 8.6%" rate
  attached to AZ properties, and have it applied automatically
  to items when ringing a sale at that property.
- Eliminate the per-item taxRate manual config (or keep it as
  override).
- Multi-state landlords stop having to remember which rate goes
  where.

This is a substantial product/UX call (single rate vs stacking;
overrides; behavior on landlord-wide-rate fallback) — flag for
when Nic wants to take it on.

### Already-known carry-forward (unchanged)

- Catalog phase 9 — form-code-uncertain pile (OK, IA, ID, NM, WV)
- Sublease phase 3 (sub-tenant billing + invite-by-email)
- POS Terminal hardware
- A3 polish (mostly diminishing returns)
- Primary manager urgency tier (S185 — needs Nic input)
- Owner-financial-escalation pattern (S186 — needs Nic input)
- B3 hard-gate check-in (product fork)
- D2 Flex tenant suite (launch-flag gated)
- CSV imports (vendor format specs)
- E2 npm upgrades (risky)
- F1 Marketing rebuild

---

End of S217 handoff.
