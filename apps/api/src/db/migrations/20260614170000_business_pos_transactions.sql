-- S497: GAM for Business — POS register schema.
--
-- Two tables scoped per business:
--
--   business_pos_transactions       — one row per completed sale
--   business_pos_transaction_lines  — items in each sale
--
-- A POS sale is always finalized in one shot (the register doesn't
-- have draft-sale semantics like invoices do). When the sale completes:
--   1. Each line writes a `sold` row to business_inventory_adjustments
--      with reference_type='pos_transaction' + reference_id=txn.id
--   2. Item stock_qty decrements
--   3. Transaction row is written with totals
-- All inside one transaction with SELECT FOR UPDATE per item.
--
-- A refund (full only in v1) walks the lines, writes `received`
-- adjustments to restore stock, and flips status to 'refunded'.
--
-- SAFE — additive only, no backfill.

-- ── business_pos_transactions ─────────────────────────────────
CREATE TABLE public.business_pos_transactions (
    id uuid DEFAULT public.gen_random_uuid() NOT NULL,
    business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
    -- Monotonic per-business receipt number (TXN-NNNNNN).
    receipt_number text NOT NULL,
    -- Optional customer link; many register sales are walk-ins.
    customer_id uuid REFERENCES public.business_customers(id) ON DELETE SET NULL,
    -- Status
    status text DEFAULT 'completed' NOT NULL,
    -- Money (snapshot at sale time)
    subtotal numeric(10,2) DEFAULT 0 NOT NULL,
    tax_amount numeric(10,2) DEFAULT 0 NOT NULL,
    total_amount numeric(10,2) DEFAULT 0 NOT NULL,
    -- Payment recording (v1: cash | card_recorded — operator handles
    -- the actual card swipe outside GAM and marks it received here).
    -- Future: 'stripe_terminal' for hardware-integrated, 'stripe_checkout'
    -- for QR/email link.
    payment_method text NOT NULL,
    amount_tendered numeric(10,2),     -- for cash sales: what the customer handed over
    change_due numeric(10,2),          -- for cash sales: change given back
    notes text,
    -- Refund tracking
    refunded_at timestamp with time zone,
    refund_reason text,
    -- Audit
    cashier_user_id uuid REFERENCES public.users(id),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT business_pos_transactions_pkey PRIMARY KEY (id),
    CONSTRAINT business_pos_transactions_status_check CHECK (
      status = ANY (ARRAY['completed'::text, 'refunded'::text, 'void'::text])
    ),
    CONSTRAINT business_pos_transactions_payment_method_check CHECK (
      payment_method = ANY (ARRAY[
        'cash'::text,
        'card_recorded'::text,
        'stripe_terminal'::text,
        'stripe_checkout'::text
      ])
    ),
    CONSTRAINT business_pos_transactions_subtotal_nonneg CHECK (subtotal >= 0),
    CONSTRAINT business_pos_transactions_tax_nonneg CHECK (tax_amount >= 0),
    CONSTRAINT business_pos_transactions_total_nonneg CHECK (total_amount >= 0),
    CONSTRAINT business_pos_transactions_refund_consistency CHECK (
      (status = 'refunded' AND refunded_at IS NOT NULL)
      OR (status <> 'refunded' AND refunded_at IS NULL)
    ),
    CONSTRAINT business_pos_transactions_unique_receipt UNIQUE (business_id, receipt_number)
);
CREATE INDEX idx_business_pos_transactions_business
  ON public.business_pos_transactions (business_id, created_at DESC);
CREATE INDEX idx_business_pos_transactions_customer
  ON public.business_pos_transactions (customer_id)
  WHERE customer_id IS NOT NULL;

CREATE TRIGGER trg_business_pos_transactions_updated_at
  BEFORE UPDATE ON public.business_pos_transactions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ── business_pos_transaction_lines ────────────────────────────
-- Snapshot the price + tax_rate at sale time (separately from the
-- item.sell_price / item.tax_rate which can change later).
CREATE TABLE public.business_pos_transaction_lines (
    id uuid DEFAULT public.gen_random_uuid() NOT NULL,
    transaction_id uuid NOT NULL REFERENCES public.business_pos_transactions(id) ON DELETE CASCADE,
    item_id uuid NOT NULL REFERENCES public.business_inventory_items(id) ON DELETE RESTRICT,
    -- Snapshot of item name + sku at sale time so historical receipts
    -- render correctly even after the item is renamed / archived.
    name_snapshot text NOT NULL,
    sku_snapshot text,
    quantity integer NOT NULL,
    unit_price numeric(10,2) NOT NULL,        -- price PER UNIT, ex-tax
    tax_rate numeric(5,4) NOT NULL,            -- snapshot, e.g. 0.0875
    line_subtotal numeric(10,2) NOT NULL,      -- unit_price * quantity
    line_tax numeric(10,2) NOT NULL,           -- line_subtotal * tax_rate
    line_total numeric(10,2) NOT NULL,         -- line_subtotal + line_tax
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT business_pos_transaction_lines_pkey PRIMARY KEY (id),
    CONSTRAINT business_pos_transaction_lines_qty_positive CHECK (quantity > 0),
    CONSTRAINT business_pos_transaction_lines_price_nonneg CHECK (unit_price >= 0),
    CONSTRAINT business_pos_transaction_lines_tax_range CHECK (tax_rate >= 0 AND tax_rate < 1)
);
CREATE INDEX idx_business_pos_transaction_lines_txn
  ON public.business_pos_transaction_lines (transaction_id, sort_order);
CREATE INDEX idx_business_pos_transaction_lines_item
  ON public.business_pos_transaction_lines (item_id);

-- ── Per-business receipt sequence ─────────────────────────────
-- Mirrors the business_invoice_sequences pattern from S493 so each
-- business gets monotonic TXN-NNNNNN numbering. Upsert-and-bump on
-- every sale.
CREATE TABLE public.business_pos_sequences (
    business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
    next_number integer DEFAULT 1 NOT NULL,
    CONSTRAINT business_pos_sequences_pkey PRIMARY KEY (business_id),
    CONSTRAINT business_pos_sequences_next_positive CHECK (next_number > 0)
);

COMMENT ON TABLE public.business_pos_transactions IS
  'S497 business-portal POS sales. One row per completed register transaction. Atomically decrements business_inventory_items.stock_qty + writes a sold adjustment per line.';
COMMENT ON TABLE public.business_pos_transaction_lines IS
  'S497 POS sale lines. Snapshots unit_price, tax_rate, name, sku at sale time so receipts render historically.';
COMMENT ON COLUMN public.business_pos_transactions.payment_method IS
  'cash | card_recorded (v1). stripe_terminal + stripe_checkout reserved for future hardware/QR integrations.';
