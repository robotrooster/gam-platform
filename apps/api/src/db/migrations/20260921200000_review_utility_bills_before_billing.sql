-- S652 — THE LANDLORD SEES THE UTILITY BILLS BEFORE THE TENANTS DO.
--
-- Nic (for Blu at Country Acres): "Blu wants to approve and see what the bills
-- are gonna be before they're generated... he wants to know how much people are
-- gonna owe... if there's a screw up he's interested in being able to correct
-- the meters if anything gets fat fingered... he'd rather fix it before the
-- people get billed than wait till they complain and have to fix it
-- retroactively." And: "without changing the billing."
--
-- properties.review_utility_bills — per-property switch. When on, a reading
--   run's bills are computed by the SAME engine but not issued: the run waits
--   for the landlord's approval, invoices that would carry those utilities are
--   held whole (the S534 hold, one more reason), and a reading can still be
--   corrected because nothing has gone out.
-- utility_reading_runs.approved_at / approved_by_user_id — the approval.
-- No backfill; Country Acres is switched on below at Nic's direction.
ALTER TABLE properties ADD COLUMN IF NOT EXISTS review_utility_bills boolean NOT NULL DEFAULT false;
ALTER TABLE utility_reading_runs
  ADD COLUMN IF NOT EXISTS approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS approved_by_user_id uuid REFERENCES users(id);
UPDATE properties SET review_utility_bills = true WHERE name = 'Country Acres - Mattoon';
