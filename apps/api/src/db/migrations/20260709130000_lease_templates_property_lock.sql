-- Property-locked lease templates (Nic, S535).
--
-- Lease forms usually carry the property's name/address in their static
-- text — sending Property A's form for a unit at Property B is a
-- classic property-manager mistake. A template may now be LOCKED to one
-- property (NULL = usable at any property). Drafting validates the
-- pairing and the pickers filter to compatible templates, so the wrong
-- property's form physically can't be sent. Upload-time detection reads
-- the PDF's text and suggests the lock automatically when it finds
-- exactly one of the landlord's property names/addresses.
--
-- Composes with unit_type: e.g. an "apartment lease locked to Oak
-- Street" and a second "apartment lease locked to Maple Court".
--
-- ON DELETE SET NULL: deleting a property unlocks its templates rather
-- than deleting the forms. No backfill needed: existing templates stay
-- NULL (any property).

ALTER TABLE lease_templates
    ADD COLUMN property_id uuid REFERENCES properties(id) ON DELETE SET NULL;

CREATE INDEX idx_lease_templates_property ON lease_templates (property_id) WHERE property_id IS NOT NULL;
