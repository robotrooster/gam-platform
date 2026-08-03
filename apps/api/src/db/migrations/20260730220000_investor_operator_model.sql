-- Investor-as-independent-operator: homes-only external parks + lot rent
-- (S568, Nic — landlord-optional adoption model).
--
-- WHY: master-subletter investors own homes across many parks WITHOUT owning any
-- park, and sublease them at a markup. GAM should let them operate fully without
-- the park owner ever being on the platform (adoption is not gated on a
-- landlord). An investor is just an OPERATOR (reuses the landlord portal); the
-- only differences from a normal landlord are (a) they don't own the land, and
-- (b) they pay LOT RENT to the external park — an expense, so their net is
-- tenant-rent − lot-rent.
--
-- properties.operator_owns_land = does the operator own the land here?
--   TRUE  (default, every existing property) = normal park the operator owns.
--   FALSE = "homes-only" external park — GAM holds only a name/address record;
--           the actual park owner is NOT on GAM (optional future upsell).
-- units.lot_rent_amount = what the operator pays the external park each month for
--   this home's lot (0 / ignored when the operator owns the land).
--
-- Safe: additive columns with backward-compatible defaults. No backfill (existing
-- properties correctly default to operator_owns_land=TRUE).

ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS operator_owns_land boolean NOT NULL DEFAULT TRUE;

ALTER TABLE units
  ADD COLUMN IF NOT EXISTS lot_rent_amount numeric(10,2) NOT NULL DEFAULT 0
  CHECK (lot_rent_amount >= 0);

COMMENT ON COLUMN properties.operator_owns_land IS
  'S568: FALSE = homes-only external park (investor operates here without owning the land; park owner not on GAM). TRUE = operator owns the park.';
COMMENT ON COLUMN units.lot_rent_amount IS
  'S568: monthly lot rent the operator pays the EXTERNAL park for this home''s lot (homes-only properties). Their net = tenant rent − lot rent.';
