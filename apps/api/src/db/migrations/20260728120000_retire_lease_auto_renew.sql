-- S562: retire lease auto-renewal (Nic).
--
-- WHY: renewal must always be a CONSCIOUS decision by both parties at renewal
-- time — no lease should silently auto-extend or revert to month-to-month and
-- leave a tenant "trapped" by forgetting their end date. processLeaseEnds no
-- longer honors auto_renew_mode ('extend_same_term' / 'convert_to_month_to_month'
-- are dead); every fixed-term lease now expires at its end_date unless a signed
-- successor renewal was explicitly drafted.
--
-- This migration flips the switch on EXISTING active leases so none carry a live
-- auto-renew into their next end date. Columns auto_renew / auto_renew_mode are
-- KEPT (no drop) but are now effectively always (false, NULL) for active leases;
-- the default is already false. Month-to-month leases that already have a NULL
-- end_date are left as-is (they never enter processLeaseEnds) — this only
-- neutralizes the auto-renew trigger, it does not force end dates onto anyone.
--
-- No backfill of end_date. Safe, idempotent (re-running sets the same values).

UPDATE public.leases
   SET auto_renew = false,
       auto_renew_mode = NULL,
       updated_at = NOW()
 WHERE status = 'active'
   AND (auto_renew = true OR auto_renew_mode IS NOT NULL);
