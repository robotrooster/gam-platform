-- S547: monthly-stay utilities note toggle (Nic).
--
-- The public quote for 30+ night stays intentionally shows only the
-- monthly rate + deposit (no lump-sum total — off-putting to guests who
-- don't think of a long stay as a bulk purchase). Utilities are almost
-- always billed back on long stays; when this is ON the quote adds
-- "plus utilities" so the monthly rate isn't mistaken as all-in.
--
-- No backfill needed (default TRUE = utilities billed back, the norm).

ALTER TABLE properties
  ADD COLUMN booking_utilities_billed boolean NOT NULL DEFAULT TRUE;
