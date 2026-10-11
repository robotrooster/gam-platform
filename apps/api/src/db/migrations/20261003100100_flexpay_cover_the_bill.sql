-- S655 money plan M2 (Step 1), item F. Expand-only: added columns, an added
-- foreign key, two indexes and two relaxed checks. Safe for the code running
-- today: FlexPay enrollment is closed and production has 0 advances.
--
-- Nic (10/2): FlexPay covers the WHOLE monthly bill on the last grace day, the
-- tenant repays GAM on the pull day they chose (never the 1st-5th), and a
-- month the tenant already paid still takes the $25.
--
--   invoice_id      the cycle invoice the cover paid
--   pull_date       the day GAM takes the money back
--   pull_attempts   runs that tried to create the pull intent (3 = default)
--   pull_last_error what Stripe said the last time
--
-- rent_amount may now be 0: a month the tenant paid themselves still has an
-- advance row for the $25. The fee must stay positive.
ALTER TABLE flexpay_advances
  ADD COLUMN IF NOT EXISTS invoice_id      uuid REFERENCES invoices(id),
  ADD COLUMN IF NOT EXISTS pull_date       date,
  ADD COLUMN IF NOT EXISTS pull_attempts   integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pull_last_error text;
ALTER TABLE flexpay_advances DROP CONSTRAINT IF EXISTS flexpay_advances_amount_positive;
ALTER TABLE flexpay_advances ADD CONSTRAINT flexpay_advances_amounts_check
  CHECK (rent_amount >= 0 AND tenant_fee_amount > 0);
ALTER TABLE flexpay_advances ADD CONSTRAINT flexpay_advances_pull_attempts_nonneg
  CHECK (pull_attempts >= 0);

-- The bill lines a cover paid, and the one FLEXPAY pull row that repays it.
ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS flexpay_advance_id uuid REFERENCES flexpay_advances(id);
CREATE INDEX IF NOT EXISTS idx_payments_flexpay_advance
  ON payments (flexpay_advance_id) WHERE flexpay_advance_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_payments_one_flexpay_pull_per_advance
  ON payments (flexpay_advance_id) WHERE entry_description = 'FLEXPAY';

-- GAM's $25 is booked as its own revenue type. Same list plus one; mirrored by
-- PLATFORM_REVENUE_TYPES in packages/shared/src/money.ts.
ALTER TABLE platform_revenue_ledger DROP CONSTRAINT IF EXISTS platform_revenue_ledger_type_check;
ALTER TABLE platform_revenue_ledger ADD CONSTRAINT platform_revenue_ledger_type_check
  CHECK (type IN ('banking_spread','manual_withdrawal_fee','placement_fee_share',
                  'platform_fee_subscription','screening_margin','adjustment',
                  'flexpay_subscription'));

COMMENT ON COLUMN payments.flexpay_advance_id IS
  'S655: on a bill line FlexPay covered (GAM float paid it on time) and on the one FLEXPAY pull row that repays it. Covered lines are GAM-held money for allocation.';
COMMENT ON COLUMN flexpay_advances.pull_attempts IS
  'S655: runs that tried to create the pull intent. The pull row is written first; a row with no intent is "create pending". After 3 failed creates the advance is defaulted and an admin is alerted.';
COMMENT ON COLUMN flexpay_advances.invoice_id IS
  'S655: the cycle invoice whose open landlord lines the cover paid (the whole monthly bill).';
COMMENT ON COLUMN flexpay_advances.pull_date IS
  'S655: the day GAM takes the covered amount plus the $25 back from the tenant''s bank. Never the 1st-5th (FLEXPAY_FORBIDDEN_PULL_DAYS).';
