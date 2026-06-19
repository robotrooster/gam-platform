-- S504: per-line discounts on invoice + quote lines (stack, line-first).
--
-- Why: S503 added whole-order discount CODES to quotes (invoices + POS
-- already had them). This adds an independent PER-LINE discount the operator
-- sets on an individual line — "10% off this part", "$5 off labor". The two
-- stack line-first (Nic-confirmed): each line's discount applies first to
-- produce its net amount, the order subtotal is the sum of those net line
-- amounts, and any whole-order code then applies to that post-line-discount
-- subtotal. Tax is computed on the fully-discounted base.
--
-- Storage per line: discount_type ('percent' | 'fixed', NULL = none),
-- discount_value (the % or $ the operator entered), discount_amount (the
-- resolved $ off, = computeDiscountAmount(type, value, gross), clamped to
-- the line's gross). line_total / line_subtotal are stored NET of the line
-- discount, so existing header roll-ups keep summing them unchanged.
--
-- POS lines (business_pos_transaction_lines) are intentionally NOT included
-- here — POS refunds are proportional to the charged line amount, so per-line
-- discounts there need a paired refund-math change; that lands in its own
-- migration/session.
--
-- No backfill needed: defaults make every existing line a 0-discount row
-- whose net (line_total) already equals its gross.

ALTER TABLE business_invoice_lines
  ADD COLUMN discount_type text,
  ADD COLUMN discount_value numeric(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN discount_amount numeric(10,2) NOT NULL DEFAULT 0,
  ADD CONSTRAINT business_invoice_lines_discount_type_check
    CHECK (discount_type IS NULL OR discount_type IN ('percent', 'fixed')),
  ADD CONSTRAINT business_invoice_lines_discount_value_nonneg
    CHECK (discount_value >= 0),
  ADD CONSTRAINT business_invoice_lines_discount_amount_nonneg
    CHECK (discount_amount >= 0),
  ADD CONSTRAINT business_invoice_lines_discount_pct_range
    CHECK (discount_type <> 'percent' OR discount_value <= 100);

ALTER TABLE business_quote_lines
  ADD COLUMN discount_type text,
  ADD COLUMN discount_value numeric(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN discount_amount numeric(10,2) NOT NULL DEFAULT 0,
  ADD CONSTRAINT business_quote_lines_discount_type_check
    CHECK (discount_type IS NULL OR discount_type IN ('percent', 'fixed')),
  ADD CONSTRAINT business_quote_lines_discount_value_nonneg
    CHECK (discount_value >= 0),
  ADD CONSTRAINT business_quote_lines_discount_amount_nonneg
    CHECK (discount_amount >= 0),
  ADD CONSTRAINT business_quote_lines_discount_pct_range
    CHECK (discount_type <> 'percent' OR discount_value <= 100);

COMMENT ON COLUMN business_invoice_lines.discount_amount IS
  'S504 per-line discount $ off (resolved from discount_type/value against gross = quantity*unit_price). line_total is stored NET of this. Whole-order discount_code on business_invoices stacks on top, line-first.';
COMMENT ON COLUMN business_quote_lines.discount_amount IS
  'S504 per-line discount $ off (resolved from discount_type/value against gross = quantity*unit_price). line_subtotal/line_tax/line_total are stored NET of this. Whole-order code stacks on top, line-first.';
