-- S536 (Nic): tips are a per-business choice, not a universal register
-- feature — "not on there for people who don't want or need it."
-- Default TRUE preserves current behavior for existing businesses
-- (tips have been unconditional since S512); operators who don't want
-- tips flip the toggle in Settings.
-- No backfill needed (DEFAULT covers existing rows).
ALTER TABLE businesses ADD COLUMN tips_enabled BOOLEAN NOT NULL DEFAULT TRUE;
