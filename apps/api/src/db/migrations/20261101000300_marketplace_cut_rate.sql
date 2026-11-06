-- Contractor marketplace — GAM's cut, as a forward-dated price card.
--
-- 10/31 (Nic): "Contractors are on the platform for free. GAM takes a cut of
-- the finished job. And I think we decided on 3%, if I remember right."
-- Asked to confirm or reset it, he confirmed 3% of the finished job. No prior
-- 3% decision existed anywhere in the repo or in memory — this migration is
-- the first time the number is written down.
--
-- WHO PAYS IT: the contractor, out of the job. The landlord pays exactly the
-- bid they accepted; GAM's 3% comes off the contractor's payout, so a $4,000
-- job bills the landlord $4,000 and pays the contractor $3,880. That follows
-- his own competitive framing — "Angie's List charges people for leads. We
-- don't want to charge that. We want to charge off of the completed job" —
-- where the people being charged are the contractors. It also keeps the
-- landlord's books honest: they owe what they agreed to, and GAM's cut never
-- appears as a line on work they commissioned.
--
-- A PRICE CARD, not a constant, for the same reason the FlexPay and FlexDeposit
-- grids are tables: re-pricing appends a row with a forward effective_from and
-- never touches a job already awarded. And, exactly like those grids, a
-- missing row is an ERROR and never a zero — "no rate configured" must not be
-- able to degrade into "GAM works for free."
--
-- The first card is backdated to 2020-01-01 because it has no predecessor.

CREATE TABLE IF NOT EXISTS marketplace_cut_rates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  percent numeric(6,3) NOT NULL CHECK (percent >= 0 AND percent <= 100),
  effective_from date NOT NULL,
  note text,
  created_at timestamptz NOT NULL DEFAULT NOW()
);

DROP INDEX IF EXISTS ux_marketplace_cut_rates_from;
CREATE UNIQUE INDEX ux_marketplace_cut_rates_from ON marketplace_cut_rates(effective_from);

INSERT INTO marketplace_cut_rates (percent, effective_from, note)
SELECT 3.000, DATE '2020-01-01',
       '10/31 Nic confirmed: 3% of the finished job, off the contractor''s payout. First card; backdated because it has no predecessor.'
WHERE NOT EXISTS (SELECT 1 FROM marketplace_cut_rates);

-- GAM's earnings book gets one more kind of row. Every GAM revenue figure on
-- the admin money page reads platform_revenue_ledger; a marketplace cut that
-- did not post here would be money earned and nowhere written down.
ALTER TABLE platform_revenue_ledger DROP CONSTRAINT IF EXISTS platform_revenue_ledger_type_check;
ALTER TABLE platform_revenue_ledger ADD CONSTRAINT platform_revenue_ledger_type_check
  CHECK (type = ANY (ARRAY[
    'banking_spread', 'manual_withdrawal_fee', 'placement_fee_share',
    'platform_fee_subscription', 'screening_margin', 'adjustment',
    'flexpay_subscription', 'device_markup', 'flexdeposit_fee',
    'flexdeposit_move_fee', 'flexdeposit_shortfall', 'flexdeposit_recovery',
    'left_owing_share',
    -- 10/31: 3% of a finished marketplace job.
    'marketplace_job_cut'
  ]));
