-- 20260430213000_strip_az_defaults_and_rename_azroc.sql
-- AZ-policy strip: remove platform defaults that bias toward Arizona.
-- properties.state DEFAULT 'AZ' becomes no-default (force explicit state at write).
-- contractors.azroc_license renamed to a generic contractor_license_number,
-- NOT NULL dropped (states without licensing skip it), and a paired
-- contractor_license_state added so the regulator body is queryable.
-- See S59 rip-pass.
--
-- Existing data: zero rows in contractors expected (subsystem is scaffolding
-- with no backend writes), so the column rename + NOT NULL drop are
-- non-destructive. If rows ever land before this runs, the rename preserves
-- the value and the new license_state column is NULL until manually populated.

ALTER TABLE properties ALTER COLUMN state DROP DEFAULT;

ALTER TABLE contractors RENAME COLUMN azroc_license TO contractor_license_number;
ALTER TABLE contractors ALTER COLUMN contractor_license_number DROP NOT NULL;
ALTER TABLE contractors ADD COLUMN contractor_license_state text;
