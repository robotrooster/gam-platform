-- S653 (Nic): "she prepays ahead of time with her tax return but she likes part
-- of the tax return to be credited on her bill each month so she still pays a
-- little bit out of pocket each month... use only a dedicated amount of the
-- credit each month, to where she would still get a partial bill each month."
--
-- prepaid_monthly_draw on the LEASE: how much paid-ahead credit a billing month
-- may use. NULL = as much as it takes (the way a year's prepayment works today).
-- Set per resident by the landlord or the desk.
--
-- lease_prepaid_credit_draws: every dollar of credit spent, with the month it
-- was spent against — what the cap is measured on, and the audit of where the
-- money went. A draw at the desk (cash + credit settling one bill) carries the
-- payment it helped settle.
ALTER TABLE leases ADD COLUMN prepaid_monthly_draw numeric(12,2)
  CHECK (prepaid_monthly_draw IS NULL OR prepaid_monthly_draw > 0);
COMMENT ON COLUMN leases.prepaid_monthly_draw IS 'S653: the most paid-ahead credit one billing month may use; NULL = no cap. The resident pays the rest of each bill themselves.';

CREATE TABLE lease_prepaid_credit_draws (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lease_id      uuid NOT NULL REFERENCES leases(id),
  credit_id     uuid REFERENCES lease_prepaid_credits(id),
  payment_id    uuid REFERENCES payments(id),
  amount        numeric(12,2) NOT NULL CHECK (amount > 0),
  billing_month date NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX lease_prepaid_credit_draws_lease_month_idx ON lease_prepaid_credit_draws (lease_id, billing_month);
COMMENT ON TABLE lease_prepaid_credit_draws IS 'S653: each draw of paid-ahead credit, by billing month — the monthly cap is measured here.';

-- The landlord's share of a bill the desk settled partly from GAM-held credit.
ALTER TABLE held_payout_items DROP CONSTRAINT held_payout_items_source_type_check;
ALTER TABLE held_payout_items ADD CONSTRAINT held_payout_items_source_type_check
  CHECK (source_type = ANY (ARRAY['pos_sale','booking_deposit','business_invoice_payment','business_pos_sale','refund','dispute','platform_fee','prepaid_draw']));
