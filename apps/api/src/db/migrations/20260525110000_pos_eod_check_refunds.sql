-- POS EOD: add check_refunds column (S342)
--
-- S339 added 'check' as a refund_method on pos_refunds but didn't
-- update the EOD settlement engine. Check refunds were silently
-- dropped from posEod.ts's totals (SUM only handled cash/card/charge),
-- so any settlement after S339 would show check refunds as zero — the
-- cashier closes the till and the books don't reflect paper checks
-- written that day.
--
-- This migration adds the column; posEod.ts is updated in the same
-- session to compute + persist it. Drawer math (cash_drawer_expected,
-- cash_drawer_variance) intentionally stays unchanged — check refunds
-- come from the checkbook, not the cash drawer, so they don't affect
-- physical drawer reconciliation. They DO need their own audit line
-- on the settlement for books-of-record completeness.
--
-- card_refunds stays in the schema for back-compat with pre-S339
-- historical rows (where 'card' was still a valid refund_method).
-- New rows will always have card_refunds = 0.
--
-- No backfill needed — pre-S342 settlement rows have no check refunds
-- to reconstruct (the 'check' refund_method didn't exist yet).

ALTER TABLE pos_eod_settlements
  ADD COLUMN check_refunds numeric(12,2) DEFAULT 0 NOT NULL;
