-- S613 (Nic): "It could be a RUBS thing. Propane could be RUBS, trash could be
-- RUBS. So all of those things need to all be in the utilities workflow."
--
-- Propane could not be a meter at all: the CHECK on utility_meters.utility_type
-- listed water/gas/electric/sewer/trash, so a propane MASTER — one central tank
-- split across the spaces it feeds — was impossible to create, and a flat
-- monthly propane charge equally so. The only propane that existed was a
-- per-space tank fill.
--
-- All three shapes are real in parks: per-space tanks (bills off deliveries via
-- propane_fills), a central tank split across spaces (a RUBS master, bills
-- through the normal engine off gallons), and a flat monthly amount. This opens
-- the two that were shut.
ALTER TABLE utility_meters DROP CONSTRAINT IF EXISTS utility_meters_utility_type_check;
ALTER TABLE utility_meters ADD CONSTRAINT utility_meters_utility_type_check
  CHECK (utility_type = ANY (ARRAY['water','gas','electric','sewer','trash','propane']));

-- The per-unit responsibility gate decides whether a utility bills a tenant at
-- all (see the S610 handoff §1a — the silent one). Propane was missing there
-- too, so a propane master would have configured cleanly and then billed
-- nothing, with no way to mark the lease responsible for it.
ALTER TABLE lease_utility_responsibilities DROP CONSTRAINT IF EXISTS lease_utility_responsibilities_utility_type_check;
ALTER TABLE lease_utility_responsibilities ADD CONSTRAINT lease_utility_responsibilities_utility_type_check
  CHECK (utility_type = ANY (ARRAY['water','gas','electric','sewer','trash','propane']));
