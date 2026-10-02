-- A new lease that could not be canceled because money was paid on it.
--
-- S655: a household's landlord-signed NEW LEASE follows a lease that ENDED EARLY
-- (a lease that replaced it), and nobody in the household signed the new one.
-- Nobody is staying on to take it up, so it never starts and the 15-minute job
-- cancels it (scheduler.processNewLeaseSignings). But a cancel is refused once
-- money has actually moved on the lease (lib/unwindIssuedLease — that is a
-- refund, not a void), e.g. a deposit top-up the tenant paid early. The job then
-- failed on every run, forever, logging an error every 15 minutes, and nobody
-- was told.
--
-- Now the job tells the landlord side ONCE (and GAM), moves the deposit record
-- back to the lease that ended, and stamps the document here. While stamped it
-- is left alone; once the payment has been returned or moved it is canceled on
-- the next run like any other.
--
--   new_lease_cancel_held_at — when the job found it could not cancel this new
--   lease because money had been paid on it, and told the landlord side.
--
-- NULL on every row today (no renewal document exists in production).
--
-- EXPAND ONLY. Nullable, no default, no backfill needed. Safe to drop.

ALTER TABLE lease_documents
  ADD COLUMN IF NOT EXISTS new_lease_cancel_held_at timestamptz;

COMMENT ON COLUMN lease_documents.new_lease_cancel_held_at IS
  'S655: when the 15-minute job could not cancel this new lease (the lease it follows ended early and nobody signed it) because money had already been paid on it, and told the landlord side and GAM. Once per document. NULL = never held.';
