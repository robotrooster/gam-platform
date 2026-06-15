-- S493: GAM for Business — invoicing schema.
--
-- New tables for the business-portal invoicing feature (gated by
-- enabled_features = 'invoicing'). Distinct from real-estate
-- `invoices` (which is heavily lease-specific: rent / utilities /
-- deposits / late-fees subtotals tied to a lease). Business invoices
-- carry free-form line items per customer and per business.
--
-- Tables:
--   business_invoices         — invoice header (one per customer per bill)
--   business_invoice_lines    — line items (description, qty, unit price)
--   business_invoice_sequences — per-business invoice-number counter
--
-- Status lifecycle:
--   draft → sent → paid       (happy path)
--   draft → void              (cancelled before sending)
--   sent  → void              (cancelled after sending — admin action)
--
-- Stripe integration columns are placeholders; the next session wires
-- destination-charge PaymentIntents through Stripe Connect (the
-- business's Connect account is already on businesses.stripe_connect_account_id).
--
-- SAFE — additive only: 3 new tables, no backfill, no changes to
-- existing tables.

-- ── business_invoice_sequences ─────────────────────────────────
-- Per-business invoice number counter. Each business gets monotonic
-- INV-0001, INV-0002, etc. independent of other businesses.
CREATE TABLE public.business_invoice_sequences (
    business_id uuid PRIMARY KEY REFERENCES public.businesses(id) ON DELETE CASCADE,
    next_number integer DEFAULT 1 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT bis_next_number_positive CHECK (next_number >= 1)
);

-- ── business_invoices ──────────────────────────────────────────
CREATE TABLE public.business_invoices (
    id uuid DEFAULT public.gen_random_uuid() NOT NULL,
    business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
    customer_id uuid NOT NULL REFERENCES public.business_customers(id),
    -- Human-readable "INV-0042"; unique per business.
    invoice_number text NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    -- Dates the business sets at create / send time.
    issue_date date NOT NULL,
    due_date date NOT NULL,
    -- Money (computed from lines on insert; updated on line CRUD).
    -- Decimal(12,2) covers up to $9,999,999,999.99 — plenty.
    subtotal numeric(12,2) DEFAULT 0 NOT NULL,
    tax_amount numeric(12,2) DEFAULT 0 NOT NULL,
    total_amount numeric(12,2) DEFAULT 0 NOT NULL,
    amount_paid numeric(12,2) DEFAULT 0 NOT NULL,
    -- Lifecycle stamps.
    sent_at timestamp with time zone,
    paid_at timestamp with time zone,
    voided_at timestamp with time zone,
    void_reason text,
    -- Payment metadata. Manual-pay is the launch path; Stripe wiring
    -- next session.
    payment_method text,                       -- 'cash' | 'check' | 'ach' | 'card' | 'other'
    stripe_payment_intent_id text,             -- populated when paid via Stripe Connect
    notes text,                                 -- free-form for the customer (visible)
    internal_notes text,                        -- business-only memo
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT business_invoices_pkey PRIMARY KEY (id),
    CONSTRAINT business_invoices_status_check CHECK (
      status = ANY (ARRAY['draft'::text, 'sent'::text, 'paid'::text, 'void'::text])
    ),
    CONSTRAINT business_invoices_subtotal_nn CHECK (subtotal >= 0),
    CONSTRAINT business_invoices_tax_nn CHECK (tax_amount >= 0),
    CONSTRAINT business_invoices_total_nn CHECK (total_amount >= 0),
    CONSTRAINT business_invoices_paid_nn CHECK (amount_paid >= 0),
    -- Audit invariants: lifecycle stamps match status.
    CONSTRAINT business_invoices_sent_audit CHECK (
      (status IN ('sent', 'paid') AND sent_at IS NOT NULL)
      OR status NOT IN ('sent', 'paid')
    ),
    CONSTRAINT business_invoices_paid_audit CHECK (
      (status = 'paid' AND paid_at IS NOT NULL) OR status <> 'paid'
    ),
    CONSTRAINT business_invoices_void_audit CHECK (
      (status = 'void' AND voided_at IS NOT NULL) OR status <> 'void'
    ),
    -- Unique invoice_number per business.
    CONSTRAINT business_invoices_unique_number UNIQUE (business_id, invoice_number)
);
CREATE INDEX idx_business_invoices_business ON public.business_invoices (business_id, created_at DESC);
CREATE INDEX idx_business_invoices_customer ON public.business_invoices (customer_id, created_at DESC);
CREATE INDEX idx_business_invoices_status ON public.business_invoices (business_id, status, due_date)
  WHERE status IN ('sent', 'draft');

CREATE TRIGGER trg_business_invoices_updated_at
  BEFORE UPDATE ON public.business_invoices
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ── business_invoice_lines ─────────────────────────────────────
CREATE TABLE public.business_invoice_lines (
    id uuid DEFAULT public.gen_random_uuid() NOT NULL,
    invoice_id uuid NOT NULL REFERENCES public.business_invoices(id) ON DELETE CASCADE,
    -- Display order on the rendered invoice. 0-indexed; small ints OK.
    sort_order integer DEFAULT 0 NOT NULL,
    description text NOT NULL,
    quantity numeric(10,2) DEFAULT 1 NOT NULL,
    unit_price numeric(12,2) NOT NULL,
    line_total numeric(12,2) NOT NULL,
    -- Optional reference to a service / product / SKU type. Free-form
    -- for now; could become a FK to a future business_services table.
    service_key text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT business_invoice_lines_pkey PRIMARY KEY (id),
    CONSTRAINT business_invoice_lines_qty_positive CHECK (quantity > 0),
    CONSTRAINT business_invoice_lines_price_nn CHECK (unit_price >= 0),
    CONSTRAINT business_invoice_lines_total_nn CHECK (line_total >= 0)
);
CREATE INDEX idx_business_invoice_lines_invoice ON public.business_invoice_lines (invoice_id, sort_order);

COMMENT ON TABLE public.business_invoices IS
  'S493 business-portal invoicing. Per-business per-customer invoices with free-form line items. Distinct from real-estate invoices (which are lease-coupled). Status: draft → sent → paid (or void from any).';
COMMENT ON TABLE public.business_invoice_lines IS
  'S493 business-invoice line items. ON DELETE CASCADE from the invoice. line_total = quantity * unit_price computed at write time.';
COMMENT ON TABLE public.business_invoice_sequences IS
  'S493 per-business invoice number counter. nextval-style: each invoice create reads + bumps in one transaction.';
