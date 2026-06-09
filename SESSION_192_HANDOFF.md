# Session 192 — closed

## Theme

`pos_items.property_id` schema + landlord assignment UI.
Locked-decision per the don't-overdefer memory: under the GAM
RV-park / extended-stay model, POS happens AT a property, not at a
landlord level. Adds the per-property scope so low-stock alerts
can route through the S183 responsible-party resolver.

This was an aborted attempt at the `leases.security_deposit` →
`lease_fees` deprecation first — recon revealed the lease_fees
CHECK doesn't include `'security_deposit'` (would need fee_type
extension + 15+ writer/reader migrations = 2-session refactor).
Pivoted to pos_items.property_id which fits one session.

## What S192 shipped

### Schema — `pos_items.property_id`

Migration `20260508150000_pos_items_property_id.sql`:

```sql
ALTER TABLE pos_items
  ADD COLUMN property_id uuid REFERENCES properties(id) ON DELETE SET NULL;

CREATE INDEX idx_pos_items_property
  ON pos_items(property_id) WHERE property_id IS NOT NULL;
```

Backfill posture: leave NULL on existing rows. Pre-S192 semantic
was "applies landlord-wide" and we don't know which property a
given item should belong to without product input. Post-S192:

- `property_id IS NOT NULL` → property-scoped, route low-stock via
  resolver
- `property_id IS NULL` → landlord-wide (legacy), route to owner

### Backend — pos.ts CRUD honors property_id

- **POST `/api/pos/items`** — accepts optional `propertyId`.
  Validates it belongs to the requesting landlord (returns 400
  otherwise). NULL is allowed and is the legacy "landlord-wide"
  posture.
- **PATCH `/api/pos/items/:id`** — `propertyId` is tri-state:
  - `undefined` → preserve current value
  - `null` → clear (revert to landlord-wide)
  - uuid → reassign (validates ownership)
- **GET `/api/pos/items`** — optional `?propertyId=` query param.
  When provided, returns items at that property UNION items with
  NULL property_id (landlord-wide stays visible at every property).
  When omitted, returns all items under the landlord (legacy
  behavior; inventory-management surface needs to see every item).

### `notifyLowStock` — per-property routing via resolver

`jobs/scheduler.ts:checkLowStock` rewritten:

- Group by `(landlord_id, property_id)`. NULL is its own bucket
  (landlord-wide).
- For each property-scoped group: route through
  `getPropertyResponsibleParty(property_id)` and loop primaries.
- For NULL-bucket: keep landlord-wide notification (legacy).

Closes the S186 "Skipped — landlord-scoped" carry-forward item.
PM-managed properties' low-stock alerts now route to PM staff
instead of the landlord owner.

### Frontend — POS app item editor

`apps/pos/src/pages/POSPage.tsx`:

- New `properties` query (cached — NotificationBell already pulls
  it).
- Add Item form: new "Property" dropdown row spanning two columns.
  "Landlord-wide (no specific property)" is the default; landlord
  selects a property to scope the item.
- Edit Item modal: same dropdown plus state plumbing on
  `editItem.property_id`. Save sends `propertyId` through the
  PATCH.
- Helper copy: "low-stock alerts route to this property's
  manager" — surfaces the routing consequence.

### Files touched (S192)

```
apps/api/src/db/migrations/20260508150000_pos_items_property_id.sql  (NEW)
apps/api/src/db/schema.sql                                           (regenerated)
apps/api/src/routes/pos.ts                                           (POST + PATCH + GET items honor property_id; ownership validation)
apps/api/src/jobs/scheduler.ts                                       (checkLowStock: group by (landlord_id, property_id), per-property route via resolver)
apps/pos/src/pages/POSPage.tsx                                       (newItem.propertyId state + property dropdown on Add Item form + Edit Item modal property selector + properties query)
```

### Verification

- `npm run db:migrate` → 1 applied; schema.sql regenerated
- `cd apps/api && npx tsc --noEmit` → 0
- `cd apps/pos && npx tsc --noEmit` → 0
- Manual smoke deferred to Nic's bench

## Decisions made (S192)

| Question | Decision |
|---|---|
| Backfill existing items to a property? | No. Pre-S192 was "applies landlord-wide" semantic; we don't know which property an item should belong to without product input. NULL preserved as legacy posture; landlord can re-assign via Edit modal. |
| GET filter behavior — strict-property-only or include landlord-wide? | Include landlord-wide. When `?propertyId=X` is given, return items at X UNION items with NULL property_id. Landlord-wide items (cleaning fee, pet fee defaults) should be visible at every property. |
| ON DELETE behavior on the property_id FK? | SET NULL. If a property is deleted, its POS items revert to landlord-wide rather than being orphaned/deleted. Matches the "items survive their context" pattern used elsewhere. |
| POS app item editor — assume landlord scope or fetch user's accessible properties? | Just call `/properties`. Backend already enforces canAccessLandlordResource on that endpoint, so users see what they're allowed to manage. NotificationBell already pulls it so it's cache-friendly. |
| Pivoted away from `leases.security_deposit` deprecation — explain in handoff? | Yes. Recon revealed the lease_fees CHECK doesn't have `'security_deposit'`, so the deprecation needs to extend the enum + migrate 15+ writer/reader sites + drop column. That's 2-session scope; carried forward as a clearly-scoped item. |

## Carry-forward — what S193+ should target

### Specific to this thread

- **`leases.security_deposit` → `lease_fees` deprecation** (deferred
  again with sharper scope this time). 2-session refactor: (1)
  Migration adds `'security_deposit'` to lease_fees fee_type CHECK,
  backfills existing leases.security_deposit values into lease_fees
  rows, drops leases.security_deposit. (2) Update writers (esign
  lease parser, lease creation, seed.ts, units.ts default amount)
  and readers (depositReturn fallback, reports rollup, frontend
  display).

- **Inventory list filter on POSPage** — show "Property" column on
  the item list with the property name (or "Landlord-wide"), and
  add a property filter dropdown at the top. Currently a landlord
  with multiple properties sees a flat list with no visual
  distinction. Quarter-session add.

- **Other POS tables for property scoping**: pos_categories,
  pos_vendors, pos_tax_rates, pos_discounts. Each is a separate
  decision — vendors might stay landlord-wide (one vendor serves
  multiple properties), tax rates might be per-property (state-line
  scenarios), discounts might be per-property. Half-to-full session
  for each that needs it. Not blocking.

### Already-known carry-forward (unchanged)

- B3 thread: needs-ack filter, SchedulePage tile badge, hard-gate
  check-in product call (S191)
- Move-out interest credit-ledger event (S188)
- Expand state catalog for deposit interest (S188)
- Tenant-facing override visibility at lease signing (S190)
- Primary manager urgency tier (S185 question)
- Owner-financial-escalation pattern (S186 question)
- Sublease subsystem
- B1+B2 material-change workflow
- C1 50-state property tax form catalog
- D2 Flex tenant suite (launch-flag gated)
- POS Terminal hardware + EOD
- CSV imports
- E2 npm upgrades
- F1 Marketing rebuild

---

End of S192 handoff.
