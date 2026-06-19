-- S503: discount codes on quotes (parity with invoices + POS).
--
-- Why: quotes were the only money surface with no discount support —
-- invoices (business_invoices.discount_code_id/discount_amount, S513) and
-- POS (business_pos_transactions, S513) already carry a code-level pre-tax
-- discount. A quote attaches a code as a PREVIEW: the dollar amount is
-- recomputed from the code on every line change so percent codes stay
-- correct, but NO redemption is consumed until the quote converts to an
-- invoice (a draft estimate that never converts must not burn a redemption).
-- The redemption is consumed at convert-to-invoice via the shared
-- applyDiscount() service, exactly as a fresh invoice would.
--
-- Money rule (mirrors POS scaled-tax): subtotal stays GROSS (sum of line
-- subtotals); discount applies pre-tax; tax is scaled by
-- (subtotal - discount)/subtotal since quote tax is per-line; total =
-- (subtotal - discount) + scaled_tax.
--
-- No backfill needed: defaults make every existing quote a 0-discount row.

ALTER TABLE business_quotes
  ADD COLUMN discount_code_id uuid
    REFERENCES business_discount_codes(id) ON DELETE SET NULL,
  ADD COLUMN discount_amount numeric(10,2) NOT NULL DEFAULT 0,
  ADD CONSTRAINT business_quotes_discount_nonneg
    CHECK (discount_amount >= 0);

COMMENT ON COLUMN business_quotes.discount_amount IS
  'S503 pre-tax discount applied via discount_code_id (preview, recomputed from the code on every line change). NO redemption consumed at quote level — consumed at convert-to-invoice. total_amount = (subtotal - discount_amount) + scaled tax_amount.';
