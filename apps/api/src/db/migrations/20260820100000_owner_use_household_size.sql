-- S609 (Nic, DIRECTIVE): owner-occupied units must carry their own weight in a
-- RUBS split, and the landlord's share must be recorded rather than absorbed
-- invisibly.
--
-- THE DEFECT. An owner-occupied unit has no lease. Under `occupant_count` it
-- therefore counts zero people, and under `rented_spaces` it counts as not
-- rented — so it contributes 0 to the basis total. Because each tenant's share
-- is `their basis ÷ the total of all bases`, and the owner's unit added nothing
-- to that total, the remaining TENANTS' shares sum to 100% of the bill.
--
-- The owner's water does not go unbilled. It is silently redistributed onto the
-- paying tenants. Nic:
--
--   "The system doesn't invoice the landlord for their own occupied spot, but
--    the ratio for the utilities is set to go out against all occupied spots.
--    But the owner occupied spots never get an invoice. So where does that leave
--    that? That's kind of a hiccup."
--
-- It leaves the tenants paying for it. That is the textbook RUBS abuse the
-- "recover only your actual charges" statutes exist to stop, and it is invisible
-- from every screen — each tenant's bill looks entirely reasonable.
--
-- (A VACANT unit taking no share is correct and deliberate: it draws nothing,
-- and the AZ RV statute names rented-spaces as the basis. An owner-occupied
-- unit is different — it is occupied and consuming.)
--
-- THE FIX, in two parts:
--
--   1. This column. An owner-occupied unit has no lease to count people from, so
--      the landlord states the household size. Defaults to 1 — a real occupied
--      home is never zero, and zero is what re-creates the bug.
--
--   2. services/utilityBilling gives the unit a real share and then WITHHOLDS
--      that share instead of billing it, recording it as an owner-use line so
--      the exclusion is provable. Nic: "We need that as a line item on a
--      specific utility cost that's owner use that is not passed through. That
--      way, if there's ever an audit, the landlord can provide, hey, these
--      utilities were not factored into being billed back to people."
--
-- Applies to every headcount-style basis. sqft / bedrooms / fixture_count are
-- unit attributes and already work for an owner-occupied unit without this.
--
-- NO BACKFILL NEEDED: the default covers every existing row, and no unit is
-- currently marked owner_use anywhere (the status existed but nothing set it).

ALTER TABLE units
  ADD COLUMN IF NOT EXISTS owner_household_size integer NOT NULL DEFAULT 1;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'units_owner_household_size_check') THEN
    ALTER TABLE units
      ADD CONSTRAINT units_owner_household_size_check
      CHECK (owner_household_size >= 1 AND owner_household_size <= 30);
  END IF;
END $$;

COMMENT ON COLUMN units.owner_household_size IS
  'S609: how many people live in an OWNER-OCCUPIED unit. Read only when units.status = ''owner_use'' — such a unit has no lease, so there are no lease_tenants rows to count, and a zero basis would push the owner''s own utility usage onto the paying tenants. Ignored for every other status.';
