-- S648 (Nic, revised the same day as 20260916140000): estimating a stuck meter
-- is a LANDLORD'S per-property choice after all, not Mountain View's alone.
--
--   "Let's make it an optional setting for landlords. If they're sub-metering an
--    RV park and their meters are broken, the landlord can set if they want to
--    bill off of an average usage of other residents, because an occupied spot
--    is using something. That's up to them whether their area law allows it or
--    not. Leave it at a property level setting."
--
-- The column and its default (off) are unchanged; only what it means is. Now
-- settable on the Utilities page. No data change.
COMMENT ON COLUMN properties.estimates_stuck_meters IS
  'S648: landlord setting. TRUE = a stuck or out-of-service submeter on an occupied space bills the low-end usage of occupied neighbours until repaired. FALSE (default) = the meter is flagged broken and bills nothing until it is marked repaired with a fresh starting reading.';
