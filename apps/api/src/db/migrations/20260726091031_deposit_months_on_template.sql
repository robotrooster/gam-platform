-- S558 (Nic): the security deposit MUST derive from the signed lease, not a
-- property-level setting. S556 stored a deposit multiplier per (property,
-- unit_type) in property_unit_type_deposits and multiplied unit rent by it at
-- draft time. That violates the #1 platform law — every charge matches the
-- signed lease: a property-level multiplier can drift from what the lease
-- actually says, and swapping templates mid-stream would silently re-price a
-- deposit that the tenant already signed for. The deposit multiplier ("one /
-- one-and-a-half / two months' rent") is a term of the LEASE, so it belongs on
-- the lease TEMPLATE (the lease's blueprint). Draft-time deposit is then
-- unit.rent × template.deposit_months, stamped onto the security_deposit box —
-- change the template and the multiplier changes with it, always matching.
--
-- Fix-forward: the S556 migration 20260725143000 stays applied; this one
-- removes the table it created and moves the concept onto lease_templates.

-- Drop the property-level multiplier table. Safe: only real occupant is the
-- S556 AFP-Verify test row (Oak Park hasn't launched; no real deposit config
-- depends on it). The multiplier now lives on lease_templates.deposit_months.
DROP TABLE IF EXISTS public.property_unit_type_deposits;

-- Deposit multiplier as a lease term, expressed on the template. NULL = the
-- template states no auto-derivable multiplier, so the landlord fills the
-- security_deposit box manually (no silent default — the lease is law, and we
-- never invent a deposit any more than we invent a late fee). CHECK mirrors the
-- old table's 0..12 bound. No backfill needed (feature pre-launch).
ALTER TABLE public.lease_templates
  ADD COLUMN deposit_months numeric(5,2)
  CONSTRAINT lease_templates_deposit_months_check
  CHECK (deposit_months IS NULL OR (deposit_months >= 0 AND deposit_months <= 12));
