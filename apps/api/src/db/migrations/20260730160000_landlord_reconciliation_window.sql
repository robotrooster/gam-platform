-- Per-landlord onboarding reconciliation window (S568, Nic — corrects the S568
-- "prior arrangement" gating).
--
-- WHY: when a landlord migrates onto GAM, their tenants may STILL be auto-debited
-- by the OLD software during the changeover. To avoid double-charging, the
-- landlord can mark a tenant's FIRST GAM rent invoice as paid off-platform. The
-- eligibility is NOT about whether the lease was imported vs newly e-signed
-- (irrelevant — at Oak Park everyone is signing fresh month-to-month leases yet
-- some are still on old-system autopay). It is about the LANDLORD being inside
-- their reconciliation window.
--
-- reconciliation_until = the timestamp the window closes. Automatic (no landlord
-- toggle): stamped to now()+21d at landlord creation (auth.ts), and backfilled
-- here for existing landlords to created_at+21d. An admin can extend it later for
-- a landlord who migrates well after signup (that's an admin action, still not a
-- landlord toggle). Past this instant, first invoices bill normally.
--
-- No destructive change; nullable column, backfilled.

ALTER TABLE landlords ADD COLUMN IF NOT EXISTS reconciliation_until timestamptz;

UPDATE landlords
   SET reconciliation_until = created_at + INTERVAL '21 days'
 WHERE reconciliation_until IS NULL;

COMMENT ON COLUMN landlords.reconciliation_until IS
  'S568: end of the landlord''s onboarding reconciliation window. While NOW() < this, the FIRST rent invoice of any of the landlord''s leases may be marked paid off-platform (old-system autopay overlap) fee-free. Default now()+21d at creation; admin-extendable.';
