# Session 220 — closed

## Theme

Property-scope `pos_categories`. S192 scoped pos_items per
property, S217 scoped pos_tax_rates per property; categories
were the last POS dimension still landlord-only. S220 closes
that loop with the same nullable-FK + filter-dropdown pattern,
so a landlord with an RV park + a convenience kiosk can run
different category vocabularies per site.

## What S220 shipped

### Schema

`apps/api/src/db/migrations/20260509104530_pos_categories_property_id.sql`:

- `pos_categories.property_id uuid REFERENCES properties(id) ON DELETE SET NULL`
- Partial index `idx_pos_categories_property` on
  `(property_id) WHERE property_id IS NOT NULL`
- COMMENT on the column documenting the legacy NULL = landlord-
  wide posture
- No backfill — every existing row stays NULL = landlord-wide,
  which is the correct semantic for the auto-seeded defaults
  (Fuel/Amenity/Laundry/Parking/Fee/Misc)

### Backend — pos.ts

- **GET /pos/categories** — accepts `?propertyId=` filter
  (orthogonal to the S219 `?all=1`). When provided, returns
  (categories at that property) ∪ (landlord-wide categories).
  Auto-seed is now gated to the no-property-filter case — an
  empty result with a propertyFilter just means "no categories
  scoped to this property", not "first load, seed defaults".
- **POST /pos/categories** — accepts `propertyId`, validates
  ownership against the landlord. Mirrors the S217 pos_tax_rates
  POST validation.
- **PATCH /pos/categories/:id** — accepts `propertyId` with the
  null/undefined/uuid trichotomy: null clears, undefined preserves,
  uuid re-assigns (with ownership validation).

### Frontend — POSPage.tsx

- `categoriesForProperty(propertyId)` helper replaces the old
  unconditional `categoryOptions` derivation. Three rules:
  - landlord-wide categories appear in every dropdown
  - property-scoped categories appear only when consuming form's
    propertyId matches
  - landlord-wide consuming context sees only landlord-wide cats
    (picking a property-scoped cat for a landlord-wide item is
    logically inconsistent)
- Add Item form — category dropdown filters by `newItem.propertyId`
- Edit Item modal — category dropdown filters by editing item's
  property_id
- Add Tax Rate form — Applies-To dropdown filters by
  `newTax.propertyId`
- Categories tab Add form — new property selector (default
  Landlord-wide)
- Categories tab list — Property column (italic "Landlord-wide" or
  gold property name, matching items + tax-rates pattern), property
  filter dropdown above the list (mirrors the items + tax-rates
  filters with All / Landlord-wide / each-property counts)
- Edit Category modal — property selector, plus a scope-change
  orphan-count warning. If re-scoping to a property would orphan
  N items currently using this category at other locations
  (their dropdown loses visibility but the category string
  remains intact), an amber callout shows the count and points
  the landlord at the Items tab. Same posture as the S219
  rename warning.

### Files touched (S220)

```
apps/api/src/db/migrations/20260509104530_pos_categories_property_id.sql  (NEW)
apps/api/src/routes/pos.ts                                                (+ ?propertyId on GET, + propertyId on POST/PATCH with ownership validation)
apps/pos/src/pages/POSPage.tsx                                            (+ categoriesForProperty helper, + property selector on Add/Edit, + Property column + filter on list, + scope-change warning)
```

### Verification

- `cd apps/api && npx tsc --noEmit` → clean
- `cd apps/pos && npx tsc --noEmit` → clean
- `npm run db:migrate` → 1 migration applied
- `psql gam -c "\d pos_categories"` → confirms property_id column,
  partial index, FK constraint
- `psql gam -c "SELECT filename FROM schema_migrations WHERE filename LIKE '%pos_categories%';"`
  → row present

## Decisions made (S220)

| Question | Decision |
|---|---|
| Nullable property_id (with NULL = landlord-wide) vs NOT NULL? | Nullable. Matches S192 (pos_items) and S217 (pos_tax_rates) — the established POS scoping pattern. NOT NULL would force a backfill choice for the 6 seeded defaults that have no natural property home. |
| Auto-seed defaults when a propertyFilter returns empty? | No. Empty result with `?propertyId=X` legitimately means "no categories scoped to this property" — landlord-wide categories will still come back via the OR. Seeding here would create stray "Misc" rows scoped to wrong properties. Auto-seed only fires when the landlord truly has zero categories (no property filter). |
| Should re-scoping a category cascade to existing items pointing at it? | No. pos_items.category stays as free-text (not FK), same as pre-S220. Cascading would require multi-row UPDATE inside the PATCH handler + a confirmation dialog if many items affected. Surfaced as an inline orphan-count warning instead — landlord can re-categorize via Items tab. Same posture as S219's rename warning. |
| Landlord-wide consuming context (item/rate with no property selected): show landlord-wide cats only, or all cats? | Landlord-wide only. Picking a property-scoped category for a landlord-wide item makes no semantic sense (the item shows everywhere; the category only at one property — inconsistent). |
| Property-scoped consuming context: include landlord-wide cats in the dropdown? | Yes. Landlord-wide acts as a base set, properties extend it. The strict alternative (only that property's cats) would force every property to get its own copy of "Misc", which is annoying. |
| Add a Bulk Recategorize action for orphaned items? | No, deferred. The scope-change warning + manual Items-tab recategorization is enough for pre-launch. If landlords start hitting this, build it. |
| Show item-count per category in the management list? | Already in place from S219. Counted client-side from already-loaded `items` query. Notably unaffected by scoping — it counts items by category-string-match regardless of property. |

## Carry-forward — S221+

### POS thread polish (S218–S220 sweep nearly complete)

- ~~**Manage Categories UI** — shipped S219.~~
- ~~**pos_categories property scoping** — shipped S220.~~
- ~~**pos_items.category dropdown should respect property scope** —
  shipped S220 (covered by `categoriesForProperty()`).~~
- **pos_items.category → FK to pos_categories.id** — bigger
  refactor, would auto-cascade renames AND scope changes,
  removing both the S219 rename warning and the S220 orphan
  warning. Requires:
  - (landlord_id, name) UNIQUE on pos_categories first
  - Backfill migration matching pos_items.category strings to
    pos_categories.id (with handling for orphans pointing at
    deleted categories — likely re-seed Misc per landlord and
    point them there)
  - PATCH route for renaming becomes a non-event (FK is by id,
    not by name)
  - Defer until a landlord asks for it.
- **(landlord_id, name) UNIQUE on pos_categories** — pre-launch
  low-risk; flag if landlords start hitting dupes.

### Future cart-math wiring

- Wire `pos_tax_rates` → cart math (S217 carry). Substantial
  product/UX call (single rate vs stacking; landlord override).
  Flag for when Nic wants to take it on. The S220 property
  scoping doesn't affect this — it's about which rates appear in
  the management dropdown, not about cart-side application.

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

End of S220 handoff.
