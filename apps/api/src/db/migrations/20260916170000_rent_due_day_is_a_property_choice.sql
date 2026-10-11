-- S648 (Nic, DIRECTIVE): GAM supports two ways of billing rent, chosen per
-- property, and a landlord may still put one tenant on their own date.
--
--   "Calendar month: prorate from the move-in date and then bill in full on the
--    first. Move-in anniversary: bill on the day of the month the tenant moved
--    in with no proration." "Maybe their due date is just going to be the 15th
--    of each month." "I don't like exceptions, but I want other landlords to be
--    able to do that... who am I to restrict them?" "Late in the month it's just
--    billed on the first."
--
-- This lifts the S582 platform lock (every lease due on the 1st).
--
--   rent_due_mode = 'fixed_day'   → every lease is due on rent_due_day (1–28)
--                   'move_in_day' → each lease is due on its move-in day, no
--                                   proration; a move-in on the 29th–31st is
--                                   due on the 1st.
-- leases.rent_due_day (already per lease) stays the value billing reads; it is
-- set from this rule when a lease is drafted and the landlord may change it on
-- the lease. No backfill: every property starts as fixed_day on the 1st, which
-- is what every lease has been.
ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS rent_due_mode text NOT NULL DEFAULT 'fixed_day',
  ADD COLUMN IF NOT EXISTS rent_due_day integer NOT NULL DEFAULT 1;
ALTER TABLE properties
  ADD CONSTRAINT properties_rent_due_mode_check CHECK (rent_due_mode IN ('fixed_day', 'move_in_day')),
  ADD CONSTRAINT properties_rent_due_day_check CHECK (rent_due_day BETWEEN 1 AND 28);
ALTER TABLE leases
  ADD CONSTRAINT leases_rent_due_day_range CHECK (rent_due_day IS NULL OR rent_due_day BETWEEN 1 AND 28);
COMMENT ON COLUMN properties.rent_due_mode IS
  'S648: fixed_day = every lease due on rent_due_day; move_in_day = each lease due on its move-in day (no proration; 29th-31st move-ins due on the 1st).';
