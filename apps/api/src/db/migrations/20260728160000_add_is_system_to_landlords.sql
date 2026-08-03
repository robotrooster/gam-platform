-- S564: system-entity flag on landlords (renter-pool intake shell support).
--
-- WHY: Checkr Tenant orders require a rental property, so a landlord-less
-- ("speculative") background check has nothing to run against. GAM operates a
-- system-owned "renter pool intake" landlord + shell property to anchor those
-- checks; completed checks then auto-migrate into application_pool. This flag
-- marks such GAM-owned system entities so they're excluded from aggregate
-- landlord counts and revenue reporting. The same account doubles as an internal
-- dogfooding login for viewing the landlord experience on real surfaces.
--
-- SAFE: additive column, NOT NULL DEFAULT false. No backfill needed — every
-- existing landlord is a real customer (is_system stays false).
ALTER TABLE public.landlords
  ADD COLUMN IF NOT EXISTS is_system boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.landlords.is_system IS
  'S564: true for GAM-owned system entities (e.g. the renter-pool intake shell landlord). Excluded from aggregate landlord counts + revenue reports; not a customer.';
