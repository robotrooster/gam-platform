-- Work-trade pause provenance (S594, Nic — close the hibernation resume gap).
--
-- WHY: leases /hibernate pauses the unit+tenant's active work-trade agreements,
-- and /resume reactivated EVERY paused agreement for that unit+tenant — including
-- one the landlord had paused by hand for an unrelated reason. Mark which pauses
-- hibernation caused so resume only reactivates those. (Flagged as a Phase-1
-- follow-on in SNOWBIRD_SEASONAL_SPEC.md; this wires it.)
--
-- SAFE: additive with a default; existing paused agreements are treated as
-- manually paused (paused_by_hibernation=false), so resume won't touch them —
-- which is the safe, conservative behavior. No backfill.

ALTER TABLE public.work_trade_agreements
  ADD COLUMN IF NOT EXISTS paused_by_hibernation boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.work_trade_agreements.paused_by_hibernation IS
  'S594: TRUE when lease hibernation paused this agreement. lease /resume reactivates only these, never a hand-paused one.';
