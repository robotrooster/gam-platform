-- S550 (Nic): who owns the DWELLING on the unit — the park/landlord, or the
-- tenant. Drives the inspection checklist master catalog:
--   * mobile_home + tenant-owned  -> the tenant owns the home, the park owns
--     the lot; space rent only, so inspections cover ONLY the space/hookups
--     (never the tenant's home interior).
--   * mobile_home + landlord-owned -> park-owned rental home; space + home
--     rent, full residential interior checklist sized to real bedrooms.
--   * rv_spot + tenant-owned      -> tenant's rig on a rented site; site-only
--     checklist (current behavior).
--   * rv_spot + landlord-owned    -> park-owned RV rented as a unit; site +
--     RV interior checklist (an RV NEVER gets bedroom areas).
-- Other unit types are landlord-owned by definition; the flag is ignored.
--
-- Backfill: existing rv_spot rows flip to 'tenant' so their checklists stay
-- exactly what they are today (site-only). Everything else keeps the
-- 'landlord' default, which is also today's behavior (full interior for
-- mobile_home). No other backfill needed.

ALTER TABLE units
  ADD COLUMN dwelling_ownership text NOT NULL DEFAULT 'landlord'
  CHECK (dwelling_ownership IN ('landlord', 'tenant'));

UPDATE units SET dwelling_ownership = 'tenant' WHERE unit_type = 'rv_spot';
