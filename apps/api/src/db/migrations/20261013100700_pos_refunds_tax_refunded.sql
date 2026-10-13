-- 10/12 (Nic) — A REGISTER REFUND STORES THE TAX IT GAVE BACK
--
-- A refund on a register sale gives back part of the sale, tax included. How
-- much of it was tax was never written down: the reports work it out every time
-- by proportion (incomeBasis: the refund, less the card fee given back with it,
-- times the sale's net over net + tax). The ledger has to post the tax given
-- back as a fact of the refund (gam-ledger-design-2026-10-12 §P1, M2).
--
-- pos_refunds.tax_refunded is written with the refund row by both writers
-- (routes/pos POST /transactions/:id/refund, earlyCheckOut.recordSaleRefund),
-- by that same proportion, from the sale's stored totals at that moment:
--   given  = amount − card_fee_refunded
--   tax    = given − ROUND(given × net / (net + tax_amount), 2)
--   net    = subtotal − discount_amount − the sale's background-check money
--            (GAM's, never refunded, never the sale's income)
-- 0 on a sale with no tax.
--
-- Backfill needed: refunds recorded before today, by the same rule
-- (scripts/oct12_ledger_source_facts_backfill.ts, named in
-- ledger_derived_facts). Production 10/12: 0 register refunds.
-- Safe drop: ALTER TABLE pos_refunds DROP COLUMN tax_refunded.

ALTER TABLE pos_refunds ADD COLUMN IF NOT EXISTS tax_refunded numeric(10,2);

COMMENT ON COLUMN pos_refunds.tax_refunded IS
  '10/12 (Nic, ledger P1): the part of this refund that was the sale''s tax, written with the refund (amount less card fee given back, by the sale''s net / (net + tax)).';
