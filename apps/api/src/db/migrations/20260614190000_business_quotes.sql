-- S501: GAM for Business — quotes / estimates.
--
-- Three new tables + a CHECK extension to enabled_features:
--
--   business_quotes              — proposal header (customer, vehicle, status, money)
--   business_quote_lines         — labor / part / fee / generic line items
--   business_quote_sequences     — per-business Q-NNNNNN counter
--
-- Plus: extend businesses.enabled_features CHECK to allow 'quotes'.
--
-- Flow:
--   draft → sent (email customer)
--        → accepted (customer says yes, owner marks it)
--        → declined (customer says no, decline_reason)
--        → expired  (sent + past expires_at — cron flip later)
-- Terminal states: accepted | declined | expired.
--
-- Convert paths from `accepted`:
--   POST /:id/convert-to-invoice    → creates business_invoices draft
--   POST /:id/convert-to-work-order → creates business_work_orders open
--
-- SAFE — additive only, no backfill.

-- ── Extend enabled_features CHECK ─────────────────────────────
ALTER TABLE public.businesses
  DROP CONSTRAINT IF EXISTS businesses_enabled_features_check;

ALTER TABLE public.businesses
  ADD CONSTRAINT businesses_enabled_features_check CHECK (
    enabled_features <@ ARRAY[
      'customers'::text,
      'staff'::text,
      'recurring_schedules'::text,
      'appointments'::text,
      'routing'::text,
      'pos'::text,
      'inventory'::text,
      'work_orders'::text,
      'customer_vehicles'::text,
      'invoicing'::text,
      'payments'::text,
      'quotes'::text
    ]
  );

-- ── business_quotes ───────────────────────────────────────────
CREATE TABLE public.business_quotes (
    id uuid DEFAULT public.gen_random_uuid() NOT NULL,
    business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
    quote_number text NOT NULL,
    customer_id uuid NOT NULL REFERENCES public.business_customers(id) ON DELETE RESTRICT,
    -- Optional vehicle linkage (mechanic vertical pre-WO estimate).
    vehicle_id uuid REFERENCES public.business_customer_vehicles(id) ON DELETE SET NULL,
    status text DEFAULT 'draft' NOT NULL,
    -- Money snapshot (recomputed on every line change).
    subtotal numeric(10,2) DEFAULT 0 NOT NULL,
    tax_amount numeric(10,2) DEFAULT 0 NOT NULL,
    total_amount numeric(10,2) DEFAULT 0 NOT NULL,
    -- Validity window — default 30 days from send (UI suggests).
    expires_at timestamp with time zone,
    -- Owner-facing memos.
    notes text,
    internal_notes text,
    -- Customer-facing problem statement (mirrors business_work_orders.complaint
    -- so the estimate carries forward into a WO cleanly on convert).
    intake_description text,
    -- Lifecycle timestamps.
    sent_at timestamp with time zone,
    accepted_at timestamp with time zone,
    declined_at timestamp with time zone,
    decline_reason text,
    -- Downstream linkage (populated by the convert endpoints).
    invoice_id uuid REFERENCES public.business_invoices(id) ON DELETE SET NULL,
    work_order_id uuid REFERENCES public.business_work_orders(id) ON DELETE SET NULL,
    created_by_user_id uuid REFERENCES public.users(id),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT business_quotes_pkey PRIMARY KEY (id),
    CONSTRAINT business_quotes_status_check CHECK (
      status = ANY (ARRAY['draft'::text, 'sent'::text, 'accepted'::text, 'declined'::text, 'expired'::text])
    ),
    CONSTRAINT business_quotes_money_nonneg CHECK (
      subtotal >= 0 AND tax_amount >= 0 AND total_amount >= 0
    ),
    CONSTRAINT business_quotes_sent_audit CHECK (
      (status IN ('sent', 'accepted', 'declined', 'expired') AND sent_at IS NOT NULL)
      OR (status = 'draft' AND sent_at IS NULL)
    ),
    CONSTRAINT business_quotes_accepted_audit CHECK (
      (status = 'accepted' AND accepted_at IS NOT NULL)
      OR (status <> 'accepted' AND accepted_at IS NULL)
    ),
    CONSTRAINT business_quotes_declined_audit CHECK (
      (status = 'declined' AND declined_at IS NOT NULL AND decline_reason IS NOT NULL)
      OR (status <> 'declined' AND declined_at IS NULL)
    ),
    CONSTRAINT business_quotes_unique_number UNIQUE (business_id, quote_number)
);
CREATE INDEX idx_business_quotes_business
  ON public.business_quotes (business_id, status, created_at DESC);
CREATE INDEX idx_business_quotes_customer
  ON public.business_quotes (customer_id);
CREATE INDEX idx_business_quotes_vehicle
  ON public.business_quotes (vehicle_id) WHERE vehicle_id IS NOT NULL;
CREATE INDEX idx_business_quotes_invoice
  ON public.business_quotes (invoice_id) WHERE invoice_id IS NOT NULL;
CREATE INDEX idx_business_quotes_work_order
  ON public.business_quotes (work_order_id) WHERE work_order_id IS NOT NULL;
-- Expiration sweep: find sent quotes whose expires_at has passed.
CREATE INDEX idx_business_quotes_expiring
  ON public.business_quotes (expires_at)
  WHERE status = 'sent' AND expires_at IS NOT NULL;

CREATE TRIGGER trg_business_quotes_updated_at
  BEFORE UPDATE ON public.business_quotes
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ── business_quote_lines ──────────────────────────────────────
-- Same shape as work-order lines — labor (hours × rate), part (links to
-- inventory but does NOT decrement stock at quote time; stock decrement
-- happens on convert-to-work-order), fee (flat), or free-form.
CREATE TABLE public.business_quote_lines (
    id uuid DEFAULT public.gen_random_uuid() NOT NULL,
    quote_id uuid NOT NULL REFERENCES public.business_quotes(id) ON DELETE CASCADE,
    line_type text NOT NULL,
    item_id uuid REFERENCES public.business_inventory_items(id) ON DELETE SET NULL,
    description text NOT NULL,
    quantity numeric(10,2) NOT NULL,
    unit_price numeric(10,2) NOT NULL,
    tax_rate numeric(5,4) DEFAULT 0 NOT NULL,
    line_subtotal numeric(10,2) NOT NULL,
    line_tax numeric(10,2) DEFAULT 0 NOT NULL,
    line_total numeric(10,2) NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT business_quote_lines_pkey PRIMARY KEY (id),
    CONSTRAINT business_quote_lines_type_check CHECK (
      line_type = ANY (ARRAY['labor'::text, 'part'::text, 'fee'::text, 'generic'::text])
    ),
    CONSTRAINT business_quote_lines_qty_positive CHECK (quantity > 0),
    CONSTRAINT business_quote_lines_price_nonneg CHECK (unit_price >= 0),
    CONSTRAINT business_quote_lines_tax_range CHECK (tax_rate >= 0 AND tax_rate < 1)
);
CREATE INDEX idx_business_quote_lines_quote
  ON public.business_quote_lines (quote_id, sort_order);

-- ── Per-business quote sequence ───────────────────────────────
CREATE TABLE public.business_quote_sequences (
    business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
    next_number integer DEFAULT 1 NOT NULL,
    CONSTRAINT business_quote_sequences_pkey PRIMARY KEY (business_id),
    CONSTRAINT business_quote_sequences_next_positive CHECK (next_number > 0)
);

-- ── Reverse linkage from invoices + work orders (set on convert) ──
ALTER TABLE public.business_invoices
  ADD COLUMN source_quote_id uuid REFERENCES public.business_quotes(id) ON DELETE SET NULL;
CREATE INDEX idx_business_invoices_source_quote
  ON public.business_invoices (source_quote_id) WHERE source_quote_id IS NOT NULL;

ALTER TABLE public.business_work_orders
  ADD COLUMN source_quote_id uuid REFERENCES public.business_quotes(id) ON DELETE SET NULL;
CREATE INDEX idx_business_work_orders_source_quote
  ON public.business_work_orders (source_quote_id) WHERE source_quote_id IS NOT NULL;

COMMENT ON TABLE public.business_quotes IS
  'S501 business-portal quotes / estimates. Pre-work price proposal sent to a customer. On accepted, owner converts to a draft invoice or open work order via the convert endpoints; downstream linkage flows both ways.';
COMMENT ON TABLE public.business_quote_lines IS
  'S501 quote line items. line_type labor (hours × rate) | part (snapshots inventory item but does NOT decrement stock) | fee | generic.';
