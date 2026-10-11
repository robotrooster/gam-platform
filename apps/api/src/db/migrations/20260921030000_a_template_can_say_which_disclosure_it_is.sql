-- S652: slots for the disclosures that exist, filled at the landlord's discretion.
--
-- Nic: "These are categories to be filled. If you want a bed bug disclosure, if
-- you want a lead based paint disclosure, if you want these other types of
-- disclosures — some of these are required in some areas. We don't police what's
-- required where... maybe there's something that's not required in one state
-- that a landlord decides, hey, it might be a good idea if I had this. Say
-- there's 15 different disclosures, maybe only two of them are required in their
-- area. We're not enforcing it, but they could upload the other 13 to kind of
-- fill out the robustness of their operation."
--
-- THIS COLUMN CARRIES NO LEGAL OPINION. There is no state mapping beside it and
-- no required flag, on purpose. GAM holds all fifty landlord-tenant acts as
-- text — enough to show somebody the statute, nowhere near enough to tell them
-- what they must sign, and telling them is not GAM's job either way.
--
-- What it buys is mechanical and worth having: the packet can put the SALE
-- version of a disclosure in front of a buyer and the RENTAL version in front of
-- a renter (lease_templates.applies_to), a landlord can see at a glance which
-- slots they have filled, and each disclosure is signed as its own document —
-- which is the thing Nic could never get out of his old software, where proving
-- receipt meant merging the disclosure into the lease and collecting initials.

ALTER TABLE lease_templates
  ADD COLUMN IF NOT EXISTS disclosure_type TEXT;

COMMENT ON COLUMN lease_templates.disclosure_type IS
  'S652: which disclosure this document IS (lead_based_paint, bed_bugs, ...). NULL = not a disclosure. Carries no requirement claim — see DISCLOSURE_TYPES in @gam/shared.';

-- Blu's two lead-paint addenda are the first of these, and the pair that
-- prompted it: the same disclosure, one for a sale and one for a rental.
UPDATE lease_templates SET disclosure_type = 'lead_based_paint'
 WHERE name IN ('Mattoon LBP - Lease', 'Mattoon LBP - Sale');

CREATE INDEX IF NOT EXISTS lease_templates_disclosure_idx
  ON lease_templates (landlord_id, disclosure_type) WHERE disclosure_type IS NOT NULL;
