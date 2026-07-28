-- S558 (Nic): RUBS-with-metered-exclusion (utility-neutral). A RUBS master can
-- physically feed units that are individually submetered (e.g. Oak Park's master
-- C feeds an apartment + RV spaces + 8 submetered mobile homes). Those submeters'
-- usage is INSIDE the master's total, so it must be SUBTRACTED before the RUBS
-- remainder is split across the non-submetered units.
--
-- Model = explicit linking (Option 1, Nic-confirmed): each submeter points to the
-- RUBS master it feeds off. rubs_parent_meter_id NULL = a standalone submeter
-- (not downstream of any RUBS master). Self-FK; ON DELETE SET NULL so removing a
-- master just unlinks its submeters. The billing engine subtracts every
-- submeter whose rubs_parent_meter_id = the master's id (same utility_type by
-- construction — a water master only has water submeters downstream). Works for
-- any utility (water/gas/electric), not just water.
--
-- No backfill: existing submeters are standalone until a landlord links them.
ALTER TABLE public.utility_meters
  ADD COLUMN rubs_parent_meter_id uuid
  REFERENCES public.utility_meters(id) ON DELETE SET NULL;

CREATE INDEX idx_utility_meters_rubs_parent ON public.utility_meters (rubs_parent_meter_id)
  WHERE rubs_parent_meter_id IS NOT NULL;
