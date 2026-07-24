-- S552: link swept screening accruals to their platform_revenue_ledger row.
-- The monthly sweep (jobs/platformFeeAccrual.ts processScreeningFeeSweep)
-- posts ONE ledger entry per landlord batch; every accrual in the batch
-- points at it. billed_at NULL = not yet swept. No backfill needed (table
-- is days old; nothing swept yet).

ALTER TABLE screening_fee_accruals
  ADD COLUMN platform_revenue_ledger_id uuid REFERENCES platform_revenue_ledger(id);
