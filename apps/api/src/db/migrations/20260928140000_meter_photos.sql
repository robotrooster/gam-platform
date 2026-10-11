-- S652 (Nic): "add the option for the maintenance person to take a picture of
-- each meter for historical accuracy… make it optional… set it at the property
-- level." A reading may carry the meter face it was read from; a property
-- decides whether its walk insists on one.
ALTER TABLE utility_meter_readings ADD COLUMN IF NOT EXISTS photo_url text;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS meter_photo_required boolean NOT NULL DEFAULT FALSE;
