-- S651: a stay sold at the register becomes a booking on the Master Schedule.
--
-- The register can already sell "RV site — daily". It takes the money and that
-- is the end of it: no site is assigned, no dates are recorded, and the
-- schedule never hears about it. Somebody is now parked on a site the software
-- believes is empty, which is how two rigs get sold the same spot.
--
-- Nic: "register stays → booking on the schedule."
--
-- THE PRICE STAYS THE REGISTER'S OWN. POS is per property — Mountain View's
-- Stays items are Mountain View's, priced to Mountain View — and the catalog
-- price is authoritative exactly as it is for propane or firewood. Nothing here
-- reaches into the unit's rate card to second-guess it. (I proposed that; Nic:
-- "why are you making prices falsely contradict. register price should be its
-- own thing.")
--
-- What the register cannot currently say is which items ARE stays, and how long
-- one of them lasts. Inferring it from the item NAME would be guesswork that
-- breaks the first time somebody types "Nightly RV" or "Cabin - wk". So the
-- item says so itself.
--
--   stay_unit = 'night' → quantity 3 means three nights
--   stay_unit = 'week'  → quantity 2 means fourteen nights
--   stay_unit = 'month' → quantity 1 means one calendar month
--   stay_unit = NULL    → an ordinary item; nothing about this changes for it
--
-- Quantity is already the one thing the register lets anybody type, which is
-- exactly the right shape for "how many nights" — no new free-text anywhere.

ALTER TABLE pos_items
  ADD COLUMN stay_unit TEXT
  CHECK (stay_unit IS NULL OR stay_unit IN ('night', 'week', 'month'));

COMMENT ON COLUMN pos_items.stay_unit IS
  'S651: non-NULL marks this item as a STAY sold at the counter, and says what one unit of quantity buys — a night, a week, or a calendar month. Selling one requires a site and a check-in date, and writes a unit_bookings row so the stay appears on the Master Schedule. NULL = an ordinary item.';

-- Which register sale produced a booking, so the two can be reconciled and a
-- refunded sale can find its stay. Nullable: every booking made through the
-- storefront, the reservation form or the waitlist has no register sale behind
-- it, and always will not.
ALTER TABLE unit_bookings
  ADD COLUMN pos_transaction_id UUID REFERENCES pos_transactions(id) ON DELETE SET NULL;

CREATE INDEX unit_bookings_pos_transaction_idx
  ON unit_bookings (pos_transaction_id) WHERE pos_transaction_id IS NOT NULL;

COMMENT ON COLUMN unit_bookings.pos_transaction_id IS
  'S651: the register sale this stay was rung up on, when it came from the counter. NULL for every other source (storefront, reservation form, waitlist).';

-- Mountain View's three existing Stays items, which are the only ones that
-- exist anywhere. Matched on the category rather than the names so a renamed
-- item still gets marked, and on the WORD in the name for the unit because
-- that is the only signal the rows carry.
UPDATE pos_items i
   SET stay_unit = CASE
         WHEN i.name ILIKE '%dail%' OR i.name ILIKE '%night%' THEN 'night'
         WHEN i.name ILIKE '%week%'  THEN 'week'
         WHEN i.name ILIKE '%month%' THEN 'month'
       END
  FROM pos_categories c
 WHERE c.id = i.category_id
   AND c.name = 'Stays'
   AND i.stay_unit IS NULL
   AND (i.name ILIKE '%dail%' OR i.name ILIKE '%night%'
        OR i.name ILIKE '%week%' OR i.name ILIKE '%month%');
