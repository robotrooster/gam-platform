-- S613 (Nic): "Filling the tank for propane is an event, but you need to link
-- which units even HAVE tanks to be filled so that you can record the event in
-- the first place."
--
-- Exactly right, and nothing recorded it. The delivery form listed every unit at
-- the property and asked for gallons on each — 30 rows at Oak Park for the
-- handful that actually have a tank — and the unit page could say nothing about
-- whether a space had propane at all.
--
-- A tank is NOT a meter and deliberately isn't stored as one: the billing engine
-- dispatches on utility_meters.billing_method, and a row it doesn't recognise
-- would fall into the RUBS path and split a propane delivery across the
-- property. Propane bills through propane_fills. This is a fact about the space
-- — does it have a tank to fill — which is all the delivery form needs to know
-- which units to offer.
--
-- Propane can still be a shared MASTER (Nic: "propane could be RUBS"): that is a
-- utility_meters row like any other and bills through the normal engine. The two
-- coexist — a park can have per-space tanks and a central tank on different
-- units — which is why this is a unit fact rather than a property mode.
ALTER TABLE units ADD COLUMN IF NOT EXISTS has_propane_tank boolean NOT NULL DEFAULT false;

-- Any unit that has ever been filled obviously has a tank. Without this, the
-- new requirement would lock existing customers out of their own workflow.
UPDATE units u SET has_propane_tank = true
 WHERE EXISTS (SELECT 1 FROM propane_fills f WHERE f.unit_id = u.id);

COMMENT ON COLUMN units.has_propane_tank IS
  'S613: this space has a propane tank that gets filled. Drives which units the '
  'delivery form offers; propane still bills through propane_fills, not a meter.';
