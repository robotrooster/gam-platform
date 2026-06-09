-- S120: extend platform_revenue_ledger.type CHECK to allow
-- 'platform_fee_subscription' — the per-occupied-unit + property-min
-- monthly SaaS fee posted by the accrual cron.
--
-- Prior values: banking_spread, manual_withdrawal_fee, placement_fee_share,
-- adjustment. New value adds the SaaS subscription revenue stream
-- ($2/billable-unit + $10/property minimum, RV/STR aggregation per
-- locked S113 rule).
--
-- When platform_fee_payer = 'landlord' (default), the cron posts to
-- platform_revenue_ledger directly. When 'tenant', the cron writes to
-- platform_fee_accruals only and the per-payment charge engine adds
-- the unpaid accrual to the next tenant rent charge as an
-- application_fee_amount add-on.

ALTER TABLE platform_revenue_ledger
  DROP CONSTRAINT platform_revenue_ledger_type_check;

ALTER TABLE platform_revenue_ledger
  ADD CONSTRAINT platform_revenue_ledger_type_check
  CHECK (type = ANY (ARRAY[
    'banking_spread',
    'manual_withdrawal_fee',
    'placement_fee_share',
    'platform_fee_subscription',
    'adjustment'
  ]));
