-- S613 (Nic): "Why does trash have any digits at all? It's not an actual meter.
-- It's either RUBS for a master bill, or per unit flat. There needs to be no
-- digits at all ever selectable on trash, because that's not a thing."
--
-- Correct. utility_meters.digits was NOT NULL DEFAULT 6, so every row got an
-- odometer width whether or not anything about it turns. The form never offered
-- the field for trash — but the 6 was there in the data, ready to surface in any
-- readout that prints it, and ready to be believed by anyone reading the table.
-- A column that is meaningless for a row should be NULL, not defaulted.
--
-- Two cases have no dial, ever:
--   · TRASH — there is no such thing as a trash odometer. It is a flat charge
--     per household, or the hauler's bill split across the units on it.
--   · any FLAT-RATE meter — a fixed amount with no reading, by definition.
-- Everything else is read: a submeter has a face, and a RUBS master is read (or
-- carries the provider's bill total) each cycle.
ALTER TABLE utility_meters ALTER COLUMN digits DROP NOT NULL;
ALTER TABLE utility_meters ALTER COLUMN digits DROP DEFAULT;

UPDATE utility_meters SET digits = NULL, updated_at = NOW()
 WHERE utility_type = 'trash' OR billing_method = 'flat_rate';

UPDATE utility_meters SET digits = 6, updated_at = NOW()
 WHERE digits IS NULL AND utility_type <> 'trash' AND billing_method <> 'flat_rate';

ALTER TABLE utility_meters DROP CONSTRAINT IF EXISTS utility_meters_digits_check;
ALTER TABLE utility_meters ADD CONSTRAINT utility_meters_digits_check
  CHECK (
    CASE WHEN utility_type = 'trash' OR billing_method = 'flat_rate'
         THEN digits IS NULL
         ELSE digits = ANY (ARRAY[4, 5, 6, 7, 8])
    END
  );

COMMENT ON COLUMN utility_meters.digits IS
  'S613: how many windows are on the METER FACE — not how long a reading is. '
  'Used only to work out the wrap when a meter passes its ceiling, and to bound '
  'what can be entered. NULL where nothing is read: trash, and any flat rate.';
