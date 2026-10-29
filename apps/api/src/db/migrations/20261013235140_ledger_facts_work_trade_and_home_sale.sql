-- 10/12 (Nic, ledger P1) — THE THREE STORED FACTS P1 LEFT FOR THEIR WRITERS:
-- the work-trade close and a home sale's activation
-- (gam-ledger-design-2026-10-12 §P1, M2).
--
--   payments.work_trade_credit   — what work-trade hours paid on this charge
--     row, in dollars. The month-close (jobs/workTradeSettlement creditInvoice)
--     credits a bill's rows by rewriting their amount and keeps no gross: a
--     $460 rent row covered by hours reads $0 settled, and nothing on the row
--     says it was ever $460. The ledger books a charge at amount +
--     work_trade_credit (rent billed) and the credit beside it. Written by the
--     close as it credits the row; the backfill
--     (scripts/oct12_ledger_source_facts_backfill) works it out for rows
--     credited before, from the change journal, and names each value it
--     filled in ledger_derived_facts.
--   payments.work_trade_settlement_id — the settlement period whose hours fell
--     short and were billed with no bill to carry them (billDeficit's
--     carried_balance / 'BALANCE' row). Until now marked only by a note. The
--     ledger books it as space rent the work did not pay (design A9) and
--     leaves it out of the opening carried balance (A8).
--   home_sale_contracts.activated_at — when the sale went active (the
--     landlord's signature, services/homeSale activateHomeSaleContractIn, or
--     an active sale written directly). A sale goes active with no date
--     today. The ledger dates the sale's posting (J2) and decides whether a
--     contract is before the books' start (J1) from it. Backfilled from
--     created_at for active and paid-off contracts; a cancelled one that was
--     never active stays NULL.
--
-- Expand-only: two nullable columns and one with a default; the old code never
-- writes them and keeps working. No backfill here — the script does it (dry
-- run by default), named in ledger_derived_facts.

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS work_trade_credit numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS work_trade_settlement_id uuid REFERENCES work_trade_settlements(id);

ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_work_trade_credit_nonneg;
ALTER TABLE payments ADD CONSTRAINT payments_work_trade_credit_nonneg CHECK (work_trade_credit >= 0);

CREATE INDEX IF NOT EXISTS idx_payments_work_trade_settlement
  ON payments (work_trade_settlement_id) WHERE work_trade_settlement_id IS NOT NULL;

ALTER TABLE home_sale_contracts
  ADD COLUMN IF NOT EXISTS activated_at timestamptz;

COMMENT ON COLUMN payments.work_trade_credit IS
  '10/12 (ledger P1): dollars of work-trade credit applied to this row at the month close (the row''s amount was lowered by it). amount + work_trade_credit = what the row billed.';
COMMENT ON COLUMN payments.work_trade_settlement_id IS
  '10/12 (ledger P1): set on the carried-balance row a work-trade period''s unworked hours were billed on when no bill carried them (jobs/workTradeSettlement billDeficit).';
COMMENT ON COLUMN home_sale_contracts.activated_at IS
  '10/12 (ledger P1): when the sale went active (started billing). NULL for a sale never activated.';
