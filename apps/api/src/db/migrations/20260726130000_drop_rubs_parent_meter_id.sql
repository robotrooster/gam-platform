-- S558 (Nic): the RUBS metered-exclusion is now UNIT-DRIVEN — a submeter is
-- excluded from a master's pool simply by sharing a served unit with that
-- master (billing derives it from utility_meter_units). The manual
-- meter-to-meter link (rubs_parent_meter_id, added 20260726120000) is gone:
-- the landlord just assigns every unit the master feeds, and the submetered
-- ones fall out automatically. Drop the column + its index.
DROP INDEX IF EXISTS public.idx_utility_meters_rubs_parent;
ALTER TABLE public.utility_meters DROP COLUMN IF EXISTS rubs_parent_meter_id;
