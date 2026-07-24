-- S550 follow-up (Nic): dwelling ownership is a SUBTYPE-level fact — the
-- landlord defines "MH Lot" (tenant-owned) vs "Park Model Rental"
-- (park-owned) once per property, and units minted from the subtype inherit
-- it. NULL = derive the type default at unit creation (rv_spot and
-- mobile_home default TENANT-owned; everything else landlord-owned).
--
-- Also flips the mobile_home default: most parks deliberately do NOT own
-- the homes — tenant-owned (space rent only) is the norm, so the S550
-- 'landlord' backfill for mobile_home was wrong. Existing mobile_home units
-- move to 'tenant'; park-owned rental homes are the exception the landlord
-- flags explicitly (per unit or via a subtype).
-- Backfill: mobile_home units -> 'tenant'. No other backfill needed.

ALTER TABLE property_unit_subtypes
  ADD COLUMN dwelling_ownership text
  CHECK (dwelling_ownership IS NULL OR dwelling_ownership IN ('landlord', 'tenant'));

UPDATE units SET dwelling_ownership = 'tenant' WHERE unit_type = 'mobile_home';
