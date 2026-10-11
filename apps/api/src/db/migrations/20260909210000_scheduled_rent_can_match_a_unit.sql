-- S639 (Nic): "April first twenty twenty eight is... you can go ahead and
-- schedule it now. Work trade ends on mobile home ten, and rent will be whatever
-- the current rate is for mobile home spaces at Mountain View for single wide
-- mobile home spaces. Have it just automatically match whatever mobile home
-- eighteen is at that point. I know it's a long term reminder, but have it do
-- that automatically."
--
-- scheduled_lease_changes already schedules a rent change and a daily job
-- already applies it, so this reuses that rather than growing a second
-- mechanism. What it could not express is the interesting half: the amount is
-- not known today. A rate eighteen months out is whatever the market is then,
-- and writing today's $460 into the future would quietly hold this space at a
-- stale rent for two years.
--
-- match_unit_id says "resolve the amount when you apply it, from that unit".
-- The reference unit carries the answer because it is the same kind of space at
-- the same park, which is exactly how Nic described it.
ALTER TABLE scheduled_lease_changes
  ADD COLUMN IF NOT EXISTS match_unit_id uuid REFERENCES units(id) ON DELETE SET NULL;

COMMENT ON COLUMN scheduled_lease_changes.match_unit_id IS
  'S639: resolve the new rent from this unit AT APPLY TIME rather than fixing an amount now. For a change years out, today''s number is the wrong answer.';

-- A rent change now needs an amount OR a unit to read one from.
ALTER TABLE scheduled_lease_changes
  DROP CONSTRAINT IF EXISTS scheduled_lease_changes_shape_check;

ALTER TABLE scheduled_lease_changes
  ADD CONSTRAINT scheduled_lease_changes_shape_check CHECK (
    ((change_type = 'rent')
      AND (new_rent_amount IS NOT NULL OR match_unit_id IS NOT NULL))
    OR
    ((change_type = 'recurring_fee')
      AND (fee_amount IS NOT NULL) AND (fee_type IS NOT NULL))
  );
