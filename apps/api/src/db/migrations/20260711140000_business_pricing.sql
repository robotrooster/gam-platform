-- S536 (Nic): business pricing locked — POS register is FREE; invoicing
-- costs $10/month in any month the business actually sends an invoice
-- (usage-based, no toggle). Collected via Stripe account debit against
-- the business's Connect balance on the 1st for the prior month.
-- Also: per-business choice of who pays card processing fees — the
-- business (fee nets out of their gross; default) or the customer
-- (surcharge auto-added to every card transaction at the register).
-- No backfill needed (defaults cover existing rows).
ALTER TABLE businesses ADD COLUMN card_fees_paid_by TEXT NOT NULL DEFAULT 'business'
  CHECK (card_fees_paid_by IN ('business','customer'));

CREATE TABLE business_platform_fee_accruals (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id      UUID NOT NULL REFERENCES businesses(id),
  month            TEXT NOT NULL,               -- 'YYYY-MM' billed period
  amount           NUMERIC(10,2) NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','collected','waived')),
  stripe_charge_id TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  collected_at     TIMESTAMPTZ,
  UNIQUE (business_id, month)
);

-- Customer-paid card surcharge recorded per sale (shows on receipts).
ALTER TABLE business_pos_transactions ADD COLUMN card_surcharge NUMERIC(10,2) NOT NULL DEFAULT 0;
