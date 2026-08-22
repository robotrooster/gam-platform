-- S617 (Nic): pay the landlord an hour after Stripe releases the money, not
-- sixteen. "The sooner it can get to the landlords, the more they're gonna
-- appreciate it."
--
-- Firing that early means our own database may not have caught up yet: a
-- payment only counts toward the platform -> Connect move once the
-- payment_intent.succeeded webhook has flipped it to 'settled', and for an ACH
-- that webhook arrives when the debit clears, at an hour nobody controls. At
-- 16:00 UTC there were sixteen hours of slack for it to land. At 01:00 UTC
-- there is one.
--
-- So an early firing that finds nothing must be FREE. Until now the trigger was
-- retired whatever the outcome, which was right when the firing was a
-- once-a-week event and wrong now: a zero-balance skip never calls Stripe at
-- all (processOneCandidate returns before creating the payout), so it costs
-- nothing, yet it spent one of the landlord's three payouts for the month.
--
-- defer_count lets such a firing be pushed to the next business day instead of
-- burned, bounded so a landlord who genuinely has no money cannot defer
-- forever. The three-per-cycle cost cap is untouched: a deferral is not a
-- payout, and the unique index still admits only three TRIGGERS per cycle.
ALTER TABLE payout_triggers
  ADD COLUMN IF NOT EXISTS defer_count integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN payout_triggers.defer_count IS
  'S617: times this trigger fired into an empty balance and was pushed to the next business day rather than retired. Capped in code (MAX_DEFERRALS).';
