-- S519: refund robustness — partial POS refunds + invoice refund recording.
--
-- Today POS refunds are full-only and invoices have no refund concept.
-- This adds:
--   POS: line-level partial refunds. A sale can be refunded item-by-item
--        (qty per line), restoring that stock, until fully refunded.
--          - refunded_qty on each line (how much of it came back)
--          - refunded_amount on the txn (running total returned)
--          - 'partially_refunded' status (between completed and refunded)
--   Invoices: a paid invoice can be refunded (full or partial) for the
--        books. GAM records it; the operator runs the actual money refund
--        on Stripe / their terminal (same posture as POS card refunds).
--          - refunded_amount / refunded_at / refund_reason on the invoice
--          - 'refunded' + 'partially_refunded' statuses
--
-- Refund dollars are proportional to the ACTUAL charged total (so a
-- discounted sale refunds the discounted amount, never the full
-- list price): line share = unit_price*refundQty / subtotal * total_amount.
--
-- SAFE — additive columns (default 0/null) + widened CHECKs. No backfill;
-- existing rows keep refunded_amount 0 and their current status.

-- ── POS ───────────────────────────────────────────────────────
ALTER TABLE public.business_pos_transactions
  ADD COLUMN refunded_amount numeric(10,2) DEFAULT 0 NOT NULL;
ALTER TABLE public.business_pos_transactions
  ADD CONSTRAINT business_pos_transactions_refunded_amount_nonneg CHECK (refunded_amount >= 0);

ALTER TABLE public.business_pos_transactions
  DROP CONSTRAINT IF EXISTS business_pos_transactions_status_check;
ALTER TABLE public.business_pos_transactions
  ADD CONSTRAINT business_pos_transactions_status_check CHECK (
    status = ANY (ARRAY['completed'::text, 'partially_refunded'::text, 'refunded'::text, 'void'::text])
  );

-- refunded_at must be set once any refund has happened (partial or full).
ALTER TABLE public.business_pos_transactions
  DROP CONSTRAINT IF EXISTS business_pos_transactions_refund_consistency;
ALTER TABLE public.business_pos_transactions
  ADD CONSTRAINT business_pos_transactions_refund_consistency CHECK (
    (status IN ('refunded', 'partially_refunded') AND refunded_at IS NOT NULL)
    OR (status NOT IN ('refunded', 'partially_refunded') AND refunded_at IS NULL)
  );

ALTER TABLE public.business_pos_transaction_lines
  ADD COLUMN refunded_qty integer DEFAULT 0 NOT NULL;
ALTER TABLE public.business_pos_transaction_lines
  ADD CONSTRAINT business_pos_transaction_lines_refunded_qty_range CHECK (
    refunded_qty >= 0 AND refunded_qty <= quantity
  );

COMMENT ON COLUMN public.business_pos_transactions.refunded_amount IS
  'S519 running total refunded (partial or full). status = partially_refunded until refunded_qty hits quantity on every line.';

-- ── Invoices ──────────────────────────────────────────────────
ALTER TABLE public.business_invoices
  ADD COLUMN refunded_amount numeric(12,2) DEFAULT 0 NOT NULL,
  ADD COLUMN refunded_at timestamp with time zone,
  ADD COLUMN refund_reason text;
ALTER TABLE public.business_invoices
  ADD CONSTRAINT business_invoices_refunded_amount_nonneg CHECK (refunded_amount >= 0);

ALTER TABLE public.business_invoices
  DROP CONSTRAINT IF EXISTS business_invoices_status_check;
ALTER TABLE public.business_invoices
  ADD CONSTRAINT business_invoices_status_check CHECK (
    status = ANY (ARRAY['draft'::text, 'sent'::text, 'paid'::text,
                        'partially_refunded'::text, 'refunded'::text, 'void'::text])
  );

COMMENT ON COLUMN public.business_invoices.refunded_amount IS
  'S519 amount refunded against a paid invoice (bookkeeping). Operator runs the actual money refund on Stripe/terminal; GAM records it.';
