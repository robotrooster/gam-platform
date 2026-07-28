-- S558 (Nic): a PROPERTY-LEVEL DEFAULT for occupancy mode — NOT a governing
-- property setting. New units inherit this value at creation, but each unit's
-- own units.occupancy_mode is authoritative and independently overridable (a
-- mostly-whole-unit building can still have a couple by-room units). Same lesson
-- as the deposit fix: the property carries a convenience DEFAULT to seed units;
-- it never governs behavior — the unit does. Defaults to whole_unit (the safe
-- mode). No backfill needed (existing units already carry their own
-- occupancy_mode from 20260726101000).
ALTER TABLE public.properties
  ADD COLUMN default_occupancy_mode text NOT NULL DEFAULT 'whole_unit'
  CONSTRAINT properties_default_occupancy_mode_check CHECK (default_occupancy_mode = ANY (ARRAY['whole_unit'::text, 'by_room'::text]));
