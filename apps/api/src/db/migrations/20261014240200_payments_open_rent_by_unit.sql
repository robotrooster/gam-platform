-- 10/13 — THE LATE-STATUS TRIGGER READS ONLY A UNIT'S OPEN RENT, NOT ITS WHOLE HISTORY
--
-- sync_unit_delinquency() (20261013120000_delinquency_first_late_day) runs for
-- EVERY payment row written, and sums the unit's rent that is pending or
-- failed, not parked under work trade, and above $0. The only index it could
-- use was idx_payments_unit (unit_id), so each call read every payment the
-- unit has ever had — settled rent, utilities, fees — to find the few still
-- open. A unit's history grows every month, and a statement writing many of a
-- unit's rows reads that history once per row.
--
-- Found on the 10/13 deploy: ledgerCoverage.test.ts writes 10,000 payments to
-- one unit, so its bulk insert and its "amount = amount" update each read
-- ~100M rows through this trigger; the full single-process suite ran it past
-- the 20s test limit (5.8s alone). Measured on gam_test with this index: the
-- trigger's share of the update 2.5s → 0.16s, the insert 1.44s → 0.65s, and
-- the planner picks it with or without fresh statistics (Index Only Scan).
--
-- The predicate is the trigger's own fixed WHERE, so a generic plan can use
-- it. No behavior changes: the same rows are summed. Expand-only; production
-- has 587 payments, so the build is instant. Idempotent.

CREATE INDEX IF NOT EXISTS idx_payments_unit_open_rent ON payments (unit_id)
  WHERE type = 'rent' AND status IN ('pending', 'failed') AND work_trade_suspended_at IS NULL AND amount > 0;
