-- S602 Snowbird Phase 5: booking deposit % reconciled to spec.
--
-- Spec (Nic): a booking (reservation) deposit is 5–20% in 5-point steps
-- (5 / 10 / 15 / 20 only — no 3%, no 18%), default 10%. The column was created
-- default 25% with a 0–100 range (drift from spec). Reset any out-of-range value
-- — including the old 25% default — to the new 10% default, then enforce the
-- discrete set. Distinct from a lease security deposit. See SNOWBIRD_SEASONAL_SPEC.md
-- Phase 5. No further backfill needed.

UPDATE properties SET booking_deposit_pct = 10
 WHERE booking_deposit_pct NOT IN (5, 10, 15, 20);

ALTER TABLE properties ALTER COLUMN booking_deposit_pct SET DEFAULT 10.00;

ALTER TABLE properties DROP CONSTRAINT IF EXISTS properties_booking_deposit_pct_range;

ALTER TABLE properties
  ADD CONSTRAINT properties_booking_deposit_pct_steps
  CHECK (booking_deposit_pct IN (5, 10, 15, 20));
