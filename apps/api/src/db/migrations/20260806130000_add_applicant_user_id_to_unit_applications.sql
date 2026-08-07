-- Listings marketplace redesign (S593): renter-initiated applications.
--
-- WHY: the public listings marketplace is moving to a 3-tier funnel — anonymous
-- teaser browse, free-account full details, and a background-check gate on the
-- Apply/Contact action. When a bg-approved renter applies to a landlord's own
-- listing (renter-initiated, inbound), we want the resulting unit_applications
-- row to carry the applicant's ACCOUNT, not just their typed contact info, so
-- the landlord can see the application came from a real bg-approved account and
-- we can join through to their background_check_status.
--
-- NULLABLE + no backfill needed: the existing anonymous public POST /apply
-- (no account) keeps writing rows with applicant_user_id = NULL, unchanged.
ALTER TABLE unit_applications
  ADD COLUMN IF NOT EXISTS applicant_user_id uuid REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_unit_applications_applicant_user_id
  ON unit_applications (applicant_user_id) WHERE applicant_user_id IS NOT NULL;
