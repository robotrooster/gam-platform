-- S639 (Nic): "I wanted to just, like, draft up a lease, essentially, from the
-- information on the background check."
--
-- The screening door and the listings door produce the same thing — a person
-- who wants a specific space starting on a specific day — but only the listings
-- door had a record shape (`unit_applications`) that the lease drafter could
-- read. Rather than grow a second drafter that would drift from the first, an
-- approved screening now MAKES an application, and the one existing path takes
-- it from there.
--
-- The unique link is what keeps a landlord clicking twice from filing two
-- applications and two draft leases for the same person.
ALTER TABLE unit_applications
  ADD COLUMN IF NOT EXISTS background_check_id uuid REFERENCES background_checks(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS unit_applications_background_check_uniq
  ON unit_applications (background_check_id)
  WHERE background_check_id IS NOT NULL;

-- The drafter has only ever produced month-to-month shells because a booking
-- carries no term. A screening does now, so the source has to be able to say so.
ALTER TABLE unit_applications
  ADD COLUMN IF NOT EXISTS desired_term_months integer;

ALTER TABLE unit_applications
  DROP CONSTRAINT IF EXISTS unit_applications_term_sane;
ALTER TABLE unit_applications
  ADD CONSTRAINT unit_applications_term_sane
  CHECK (desired_term_months IS NULL OR (desired_term_months > 0 AND desired_term_months <= 120));
