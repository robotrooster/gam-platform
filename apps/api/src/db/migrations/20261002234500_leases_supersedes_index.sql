-- Renewals: find the lease that continues this one, without scanning every lease.
--
-- The nightly bill run asks, for EVERY active lease, whether a fully signed
-- renewal of it exists (leases.supersedes_lease_id = this lease) so the old
-- lease never bills on or after the renewal starts. The lease-end job, the
-- utility hand-off and the renewal-tendency report ask the same question.
-- supersedes_lease_id had no index, so each lookup read the whole leases table:
-- nothing at 81 leases, the square of the lease count at an 11,000-unit PM.
--
-- Partial: almost every lease supersedes nothing.
--
-- EXPAND ONLY. No backfill needed.

CREATE INDEX IF NOT EXISTS idx_leases_supersedes
  ON leases (supersedes_lease_id)
  WHERE supersedes_lease_id IS NOT NULL;
