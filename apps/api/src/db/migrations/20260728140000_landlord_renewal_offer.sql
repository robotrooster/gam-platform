-- S562: landlord-first renewal (Nic).
--
-- WHY: the tenant renewal survey ("do you want to renew?") must NOT release to
-- the tenant until the LANDLORD has signaled they're willing to renew — there's
-- no reason to ask the tenant if the landlord already plans to remodel, re-let,
-- or otherwise not renew. The landlord decides first; their offer releases the
-- survey; the tenant responds; then the renewal lease is drafted (existing flow).
--
-- `landlord_renewal_offered_at` is the gate: NULL = not offered (survey hidden);
-- set = landlord offered renewal (survey shows). No backfill (nullable).

ALTER TABLE public.leases
  ADD COLUMN IF NOT EXISTS landlord_renewal_offered_at timestamp with time zone;
