-- 10/20 (Nic) — DISPENSED PROPANE IS A PRODUCT. DELIVERED PROPANE IS A UTILITY.
-- AND THE LINE BETWEEN THEM IS NEVER DRAWN FROM A UNIT TYPE.
--
--   "Propane is a product in the point of sale. On delivery to the site, that is
--    a utility. It's basically at Mountain View, the distinction line is going
--    to be larger tanks that the company will come fill are only at mobile home
--    sites. At another property that's yet to be onboarded, that will also
--    happen at RV sites. So it needs to not be unit type exclusive. But it does
--    need to have the distinction between delivery and dispensed."
--
-- And on why the two can't share a shelf:
--
--   "Propane needs to not be in the utilities category. It needs to be as a
--    product... That's not a bill back thing. That's a, we charge it at the time
--    of dispensing. So that needs to not kind of be lumped in with electric in
--    any way, shape, or form. It doesn't go on books the same way. We charge
--    sales tax on it. It's two separate things."
--
-- WHAT IS ACTUALLY BROKEN TODAY. The register has no column saying what a line
-- IS, so whether a sale counts as utility money given back is decided by two
-- STRINGS: the category name has to start with "utilit" and the item name has to
-- contain electric / water / sewer / trash / gas (routes/utility.ts
-- registerUtilityType, mirrored in services/rentRoll.ts registerBillBackOf).
-- Mountain View's "Propane" at $3.30/gal sits in a category literally named
-- "Utilities" and is safe only because the word "Propane" happens to match none
-- of those patterns. Name the same button "Propane gas" — an ordinary thing for
-- a front-desk person to type — and \mgas\M fires: $328 of taxable fuel revenue
-- gets counted as gas bill-back recovery. Worse, both of those strings are
-- CLIENT-SUPPLIED on the way in (services/posSale.ts took item.cat and
-- item.name straight off the request), so the classification of money was
-- decided by text the register posted.
--
-- That is a one-keystroke money error, and it becomes a real one the moment
-- register sales start counting as utility recovery.
--
-- THE FIX IS A FLAG ON THE ITEM, NOT A CATEGORY AND NOT A NAME.
-- recovers_utility NULL  = this is a PRODUCT. Its money is sales revenue, it
--                          carries sales tax, and nothing that sweeps utilities
--                          may ever touch it. Dispensed propane lives here.
-- recovers_utility <type> = this line gives back spend on that utility.
--
-- Why not a new category: a category is a MERCHANDISING grouping whose name the
-- landlord types and renames at will (pos_categories has no fixed vocabulary —
-- its only constraint is a unique free-text name per landlord). A name somebody
-- can edit cannot carry what money means. Moving the item to a product category
-- is still right and is still coming — but as honesty in the catalog, not as the
-- safety mechanism.
-- Why not an "item kind": there is no such column, and the nearest thing,
-- pos_items.stay_unit, is exactly this shape already — a nullable discriminator
-- on this same table where NULL means "not one of those". Same grain the tax
-- system already uses too: pos_tax_rates scopes by item_ids.
--
-- AND NOTHING HERE LOOKS AT A UNIT TYPE. Delivered propane is marked on the
-- SPACE (units.has_propane_tank, S613) and dispensed propane is marked on the
-- ITEM (here). A mobile home site and an RV site reach both the same way, so
-- the property that hasn't been onboarded yet works on its first day.
--
-- EXPAND ONLY. Two nullable columns and a backfill that writes TODAY'S ANSWER
-- into them — the same CASE routes/utility.ts runs right now, character for
-- character, so no line's classification changes. Mountain View's electric item
-- and its 51 electric sale lines resolve to 'electric' exactly as they do today;
-- Propane and its 14 sales stay NULL, which is both today's answer and the right
-- one. Nothing is reclassified here. Re-runnable.

ALTER TABLE pos_items
  ADD COLUMN IF NOT EXISTS recovers_utility text;

ALTER TABLE pos_items DROP CONSTRAINT IF EXISTS pos_items_recovers_utility_check;
ALTER TABLE pos_items ADD CONSTRAINT pos_items_recovers_utility_check
  CHECK (recovers_utility IS NULL OR recovers_utility = ANY (ARRAY['water','gas','electric','sewer','trash','propane']));

COMMENT ON COLUMN pos_items.recovers_utility IS
  '10/20: which metered utility a sale of this item gives back, or NULL when it '
  'is a PRODUCT (dispensed propane, firewood, a dump-station fee) whose money is '
  'sales revenue and must never be swept as utility recovery. Explicit on the '
  'item — never inferred from the category name, the item name or the unit type. '
  'Same values as @gam/shared UTILITY_TYPES.';

-- The SNAPSHOT. A sale line keeps the answer that was true when it was rung up.
-- pos_transaction_items already snapshots item_name, item_category, unit_price
-- and tax_rate for the same reason, and item_id is ON DELETE SET NULL, so
-- reading the live catalog to classify a year-old sale would restate history
-- every time a landlord renamed a button — the exact sin propane_fills avoids by
-- snapshotting true_cost_per_gallon instead of reading today's markup.
ALTER TABLE pos_transaction_items
  ADD COLUMN IF NOT EXISTS recovers_utility text;

ALTER TABLE pos_transaction_items DROP CONSTRAINT IF EXISTS pos_transaction_items_recovers_utility_check;
ALTER TABLE pos_transaction_items ADD CONSTRAINT pos_transaction_items_recovers_utility_check
  CHECK (recovers_utility IS NULL OR recovers_utility = ANY (ARRAY['water','gas','electric','sewer','trash','propane']));

COMMENT ON COLUMN pos_transaction_items.recovers_utility IS
  '10/20: what this line was when it was sold — which utility it gives back, or '
  'NULL for a product. Snapshotted from the item at sale time (services/posSale), '
  'never from the request body, so a renamed button cannot restate a settled '
  'month and a typed category cannot invent recovery.';

-- Backfill: today's rule, written down. Mirrors routes/utility.ts
-- registerUtilityType exactly, including the order of the branches.
--
-- The WHERE narrows to the rows that will actually GET a value, so a product
-- (propane included) is not rewritten from NULL to NULL. Every money table here
-- carries the change journal's trigger and that journal is never pruned — an
-- UPDATE touching every catalog row to say nothing would be noise in the one
-- record of what a row used to say.
UPDATE pos_items i SET recovers_utility = CASE
      WHEN i.name ~* '\melectric'        THEN 'electric'
      WHEN i.name ~* '\mwater'           THEN 'water'
      WHEN i.name ~* '\msewer'           THEN 'sewer'
      WHEN i.name ~* '\m(trash|garbage)' THEN 'trash'
      WHEN i.name ~* '\mgas\M'           THEN 'gas'
    END
 WHERE i.recovers_utility IS NULL
   AND COALESCE((SELECT c.name FROM pos_categories c WHERE c.id = i.category_id), '') ILIKE 'utilit%'
   AND i.name ~* '\m(electric|water|sewer|trash|garbage|gas\M)';

UPDATE pos_transaction_items ti SET recovers_utility = CASE
      WHEN ti.item_name ~* '\melectric'        THEN 'electric'
      WHEN ti.item_name ~* '\mwater'           THEN 'water'
      WHEN ti.item_name ~* '\msewer'           THEN 'sewer'
      WHEN ti.item_name ~* '\m(trash|garbage)' THEN 'trash'
      WHEN ti.item_name ~* '\mgas\M'           THEN 'gas'
    END
 WHERE ti.recovers_utility IS NULL
   AND COALESCE(ti.item_category, '') ILIKE 'utilit%'
   AND ti.item_name ~* '\m(electric|water|sewer|trash|garbage|gas\M)';
