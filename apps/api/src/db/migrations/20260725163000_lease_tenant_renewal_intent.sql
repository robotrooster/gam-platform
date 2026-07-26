-- S556: capture the TENANT's renewal intent (the dead-since-S555 tenant survey).
-- The tenant portal's lease page shows a "Do you plan to renew?" survey within
-- 60 days of expiry, but its POST /leases/:id/renewal-intent had no endpoint
-- (404, silently swallowed) and no place to store the answer. This adds the
-- lease-level intent so the survey hides once answered (the tenant payload is
-- SELECT l.*, so it flows through as tenantRenewalIntent) and the landlord can
-- see where each tenant stands.
--
-- A "yes" also opens a lease_renewal_request (the landlord's renewal workflow);
-- "no"/"unsure" are recorded here for visibility. No backfill (null = not asked).

ALTER TABLE public.leases
  ADD COLUMN IF NOT EXISTS tenant_renewal_intent text,
  ADD COLUMN IF NOT EXISTS tenant_renewal_intent_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS tenant_renewal_notes text;

ALTER TABLE public.leases
  ADD CONSTRAINT leases_tenant_renewal_intent_check
  CHECK ((tenant_renewal_intent IS NULL) OR (tenant_renewal_intent = ANY (ARRAY['yes'::text, 'no'::text, 'unsure'::text])));
