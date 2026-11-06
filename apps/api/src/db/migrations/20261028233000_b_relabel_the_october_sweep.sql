-- 10/28 — the one payout already filed as the weekly run when it was the sweep.
--
-- 20261028230000 added the 'month_end_sweep' trigger and the code now files it,
-- but October's sweep had already been written as 'auto_friday'. That row is
-- what the owner was looking at when he asked why he had two weekly payouts a
-- day apart, so leaving it mislabelled leaves his own question unanswered on
-- the screen.
--
-- Matched by its Stripe payout id and guarded on the value it is expected to
-- hold, so it cannot touch a genuine weekly run or re-run differently later.
-- The sweep for October 2026 is 2026-10-28 UTC (two business days before the
-- last business day, 10-30); this payout was created at 2026-10-28 01:00 UTC.

UPDATE disbursements
   SET trigger_type = 'month_end_sweep'
 WHERE stripe_payout_id = 'po_1UVLDjDngULWfeVLDIvQckhM'
   AND trigger_type = 'auto_friday';

-- (disbursements has no updated_at column.)
