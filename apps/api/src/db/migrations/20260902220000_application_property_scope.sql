-- S636 (Nic): "I need a link that takes them to that flow through a QR
-- code. It needs to map that tenant inquiry or invite or background to
-- that specific property."
--
-- Every piece of the applicant flow already existed — the public apply
-- endpoint, unit_applications, the Checkr screening, the applicant
-- pool, the per-property {slug}.gam.biz site, and a QR helper. What was
-- missing is that NONE of it carried the property.
--
-- unit_applications could only be scoped by unit_id, and a walk-up
-- applying to a park (rather than to one specific space) has no unit
-- yet — so the row landed with landlord_id only. With several parks per
-- landlord that loses which park they walked into, which is exactly the
-- ambiguity the property-scoping directive exists to prevent.
ALTER TABLE unit_applications
  ADD COLUMN IF NOT EXISTS property_id uuid REFERENCES properties(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_unit_applications_property
  ON unit_applications (property_id) WHERE property_id IS NOT NULL;

-- Backfill from the unit where one was named — a unit already implies
-- its property, so these were never ambiguous, just unrecorded.
UPDATE unit_applications a
   SET property_id = u.property_id
  FROM units u
 WHERE a.unit_id = u.id AND a.property_id IS NULL;
