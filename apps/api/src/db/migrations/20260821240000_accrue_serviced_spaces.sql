-- S615: the $2 for a serviced space was shown but never charged.
--
-- S614 taught the LIVE ESTIMATE (services/platformFee.ts) to count spaces the
-- landlord bills utilities for — "it is technically a unit, so it needs to be
-- billed at two dollars." It did not teach the ACCRUAL JOB, which is the thing
-- that actually charges. So GAM quoted the landlord a number one higher than
-- the invoice it then sent, every month, for every serviced space — and GAM
-- silently under-collected its own revenue.
--
-- Broken out as its own count rather than folded into long_term_unit_count so
-- the landlord's fee line can say what it is made of. A serviced space is not
-- a long-term tenancy and should not be reported as one.
ALTER TABLE platform_fee_accruals
  ADD COLUMN IF NOT EXISTS utility_service_unit_count integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN platform_fee_accruals.utility_service_unit_count IS
  'S615: spaces billed under a utility service agreement this month — occupied '
  'by this landlord BECAUSE OF the utilities. Drops the moment a lease '
  'supersedes the agreement, so the $2 follows the unit and is never charged '
  'twice for one space.';
