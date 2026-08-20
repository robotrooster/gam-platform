-- S607 (Nic, DIRECTIVE): RUBS recovers the BILL, not gallons × a rate we chose.
--
-- Nic: "I think you're allowed to take the total dollar value of the bill and
-- divide it out, not just the gallons usage. That way you're recouping the full
-- cost of the bill. On a bill with low gallon usage and then your base fee,
-- you're not recouping that."
--
-- He is right, and Arizona says so in three places. A.R.S. § 33-2107(C)(1) (RV
-- spaces rented over 180 days) lets the landlord "recover the charges imposed on
-- the landlord by the utility provider", and defines charges as "the landlord's
-- actual expense of obtaining the utility, including the taxes and fees assessed
-- by or through the utility provider". § 33-1314.01(B) says the same for
-- apartments. Neither authorises a per-gallon rate the landlord picks; both
-- authorise recovery of the actual dollars. Billing gallons × $0.01 left every
-- service charge, tax and provider fee on the landlord, cycle after cycle.
--
-- THE MODEL (Nic's pick — "simple proportional", one blended line):
--   The master's cycle entry becomes TWO numbers off the utility's own bill,
--   total gallons and total dollars. Blended rate = dollars ÷ gallons, so the
--   base fee is INSIDE the rate rather than a second line item. Nic: "if they
--   see it nickel and dimed as separate charges — here's the water rate, here's
--   the fee for the water — they're not gonna like it... that just needs to have
--   a blended rate on the back end to include any fee."
--   Submetered units on that line bill their MEASURED gallons at the blended
--   rate; the remaining dollars split across the RUBS spaces. Every tenant on
--   the line pays the park's true cost per gallon and the bill recovers exactly.
--
-- WHAT THIS MIGRATION ADDS
--
-- 1. utility_meter_readings.bill_amount — the master's dollar bill for the
--    cycle. NULL everywhere else; a submeter has no bill of its own. NULL on a
--    master too means "not entered yet", and the engine falls back to the old
--    gallons × rate path, so nothing in flight changes shape mid-cycle.
--
-- 2. rubs_allocation_method 'rented_spaces' — REQUIRED for Arizona RV spaces.
--    § 33-2107(C)(4): "Allocation shall be made on the basis of rented spaces."
--    Oak Park's master is on occupant_count, which is not a permitted basis
--    there. It also fixes a quiet under-recovery in equal_split: that gives
--    every assigned unit a basis of 1 including VACANT ones, whose share then
--    fails the tenant lookup and is silently never billed — so the landlord ate
--    the vacancies' slice of a bill he had already paid. rented_spaces counts
--    only spaces with an active lease, which is both the statutory basis and
--    the one that recovers the whole bill.
--
-- 3. utility_bills.reading_start_date / reading_end_date — the bill format both
--    statutes mandate is "the opening and the closing meter readings AND THE
--    DATES of the meter readings" (§ 33-1413.01(A), § 33-1314.01(E)(1)). We
--    snapshotted the readings and dropped the dates.
--
-- 4. property_utility_rates.prevailing_residential_rate — the ceiling in
--    § 33-1413.01(B) (mobile home parks) and § 33-2107(B)(3) (RV submetering):
--    the landlord "shall not charge more than the prevailing basic service
--    single family residential rate charged by the serving utility". A park
--    master usually sits on a larger meter with a larger service charge, so a
--    blended rate CAN come out above what a single-family customer pays. Where
--    this is set the submeter charge is capped at it and the landlord absorbs
--    the difference — the shortfall must not be pushed onto the RUBS spaces,
--    which is why the pool still subtracts the uncapped amount.
--    Optional: unset means uncapped, so it never blocks a landlord who hasn't
--    looked up the tariff yet.

ALTER TABLE utility_meter_readings
  ADD COLUMN IF NOT EXISTS bill_amount numeric(12,2);

COMMENT ON COLUMN utility_meter_readings.bill_amount IS
  'S607: RUBS master only — the utility provider''s total dollar charge for this cycle (A.R.S. § 33-2107(C)(1) "actual expense of obtaining the utility, including the taxes and fees"). With reading_value (total gallons) it gives the blended rate the whole line bills at. NULL on submeters, and on a master means the dollar bill was not entered.';

ALTER TABLE utility_meters
  DROP CONSTRAINT IF EXISTS utility_meters_rubs_allocation_method_check;
ALTER TABLE utility_meters
  ADD CONSTRAINT utility_meters_rubs_allocation_method_check
  CHECK (rubs_allocation_method = ANY (ARRAY[
    'occupant_count'::text, 'sqft'::text, 'bedrooms'::text,
    'equal_split'::text, 'rented_spaces'::text]));

ALTER TABLE utility_bills
  ADD COLUMN IF NOT EXISTS reading_start_date date,
  ADD COLUMN IF NOT EXISTS reading_end_date   date;

COMMENT ON COLUMN utility_bills.reading_end_date IS
  'S607: the date of the closing read. Both A.R.S. § 33-1413.01(A) and § 33-1314.01(E)(1) require each bill to show the opening and closing readings AND their dates.';

ALTER TABLE property_utility_rates
  ADD COLUMN IF NOT EXISTS prevailing_residential_rate numeric(12,5);

COMMENT ON COLUMN property_utility_rates.prevailing_residential_rate IS
  'S607: the serving utility''s prevailing basic-service single-family residential rate, per unit of usage. Statutory CEILING on what a submetered tenant may be charged (A.R.S. § 33-1413.01(B), § 33-2107(B)(3)). NULL = not looked up yet, no cap applied. The landlord absorbs any capped shortfall; it is never reallocated to the RUBS spaces.';
