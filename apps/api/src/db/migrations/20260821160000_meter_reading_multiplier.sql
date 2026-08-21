-- S613 (Nic): a meter face that counts in HUNDREDS of gallons.
--
--   "All those reads are supposed to be scooted over two digits. The four
--    thirteen — the meter only counts over every hundred gallons, so the four
--    thirteen is really forty one thousand three hundred, and the forty five is
--    forty five hundred. The last two digits are always zero on this particular
--    water read at this property."
--
-- He reads and records the FACE (413). The gallons are 41,300. Nothing in GAM
-- knew that, so usage was being taken straight off the face and a penny-per-
-- gallon bill would have come out 100× light — $0.26 where the tenant owed $26.
-- This was offered earlier and declined on the understanding that the entered
-- number already WAS gallons; the reads he actually took show otherwise, which
-- is exactly why it matters that it is stored rather than assumed.
--
-- The multiplier belongs to the METER, not the property: a park can have one
-- water meter that turns per gallon and another per hundred, and the guy walking
-- the route reads each face as it is painted.
--
-- What it does NOT change: the number entered and displayed is always the FACE.
-- Nobody should have to do arithmetic to write down a meter read, and the stored
-- read stays comparable to the dial for the rest of the meter's life. Only the
-- USAGE derived from two reads is multiplied.
ALTER TABLE utility_meters
  ADD COLUMN IF NOT EXISTS reading_multiplier numeric(10,4) NOT NULL DEFAULT 1
    CHECK (reading_multiplier > 0);

COMMENT ON COLUMN utility_meters.reading_multiplier IS
  'S613: what ONE turn of the last digit on the FACE is worth in billing units. '
  '1 = the face is already gallons/kWh. 100 = a face that counts per hundred '
  'gallons (413 on the dial = 41,300 gallons). Reads are entered and shown as '
  'the face; only usage is multiplied.';
