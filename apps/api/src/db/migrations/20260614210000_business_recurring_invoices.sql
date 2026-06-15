-- S505: recurring invoice schedules.
--
-- Use case: lawn care, gym memberships, IT support, equipment rental,
-- storage units — businesses that bill a customer the same amount on
-- a regular cadence. Owner creates a "schedule" with line items and
-- the cron auto-generates an invoice each cycle.
--
-- Two tables + a reverse FK on business_invoices:
--
--   business_recurring_invoice_schedules — header (customer, frequency, next_due)
--   business_recurring_invoice_lines     — line items template
--   business_invoices.source_recurring_schedule_id — reverse link on each generated invoice
--
-- Frequency v1: weekly | monthly. (biweekly / quarterly / annually
-- defer until a real customer asks for them — adding to the CHECK is
-- a one-line fix-forward migration.)
--
-- Generation semantics:
--   - Cron runs daily; selects schedules where status='active' AND
--     next_due_date <= CURRENT_DATE AND (end_date IS NULL OR end_date >= CURRENT_DATE)
--   - For each match: create business_invoices draft + lines + bump
--     next_due_date by the frequency. If auto_send=TRUE, the route
--     handler also stamps sent_at and fires the customer email
--     (same path as POST /:id/send).
--   - last_invoice_id keeps the most recent generated invoice for
--     quick "what did this customer get last cycle" lookups.
--
-- SAFE — additive only, no backfill.

CREATE TABLE public.business_recurring_invoice_schedules (
    id uuid DEFAULT public.gen_random_uuid() NOT NULL,
    business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
    customer_id uuid NOT NULL REFERENCES public.business_customers(id) ON DELETE RESTRICT,
    name text NOT NULL,
    -- Cadence
    frequency text NOT NULL,
    day_of_month integer,             -- when frequency='monthly' (1..28)
    day_of_week integer,              -- when frequency='weekly' (0=Sunday..6=Saturday)
    -- Window
    start_date date NOT NULL,
    end_date date,                    -- NULL = open-ended
    next_due_date date NOT NULL,      -- the date the next invoice should be cut
    -- Behavior
    auto_send boolean DEFAULT TRUE NOT NULL,
    payment_terms_days integer DEFAULT 30 NOT NULL,
    status text DEFAULT 'active' NOT NULL,
    notes text,
    internal_notes text,
    -- Stats / linkage
    created_invoice_count integer DEFAULT 0 NOT NULL,
    last_invoice_id uuid REFERENCES public.business_invoices(id) ON DELETE SET NULL,
    last_generated_at timestamp with time zone,
    -- Audit
    created_by_user_id uuid REFERENCES public.users(id),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT business_recurring_invoice_schedules_pkey PRIMARY KEY (id),
    CONSTRAINT business_recurring_invoice_schedules_frequency_check CHECK (
      frequency = ANY (ARRAY['weekly'::text, 'monthly'::text])
    ),
    CONSTRAINT business_recurring_invoice_schedules_status_check CHECK (
      status = ANY (ARRAY['active'::text, 'paused'::text, 'ended'::text])
    ),
    CONSTRAINT business_recurring_invoice_schedules_dom_range CHECK (
      day_of_month IS NULL OR (day_of_month >= 1 AND day_of_month <= 28)
    ),
    CONSTRAINT business_recurring_invoice_schedules_dow_range CHECK (
      day_of_week IS NULL OR (day_of_week >= 0 AND day_of_week <= 6)
    ),
    -- Monthly requires day_of_month; weekly requires day_of_week.
    CONSTRAINT business_recurring_invoice_schedules_cadence_check CHECK (
      (frequency = 'monthly' AND day_of_month IS NOT NULL AND day_of_week IS NULL)
      OR
      (frequency = 'weekly'  AND day_of_week  IS NOT NULL AND day_of_month IS NULL)
    ),
    CONSTRAINT business_recurring_invoice_schedules_terms_positive CHECK (payment_terms_days > 0),
    CONSTRAINT business_recurring_invoice_schedules_count_nonneg CHECK (created_invoice_count >= 0),
    CONSTRAINT business_recurring_invoice_schedules_end_after_start CHECK (
      end_date IS NULL OR end_date >= start_date
    )
);
CREATE INDEX idx_brisched_business
  ON public.business_recurring_invoice_schedules (business_id, status, next_due_date);
CREATE INDEX idx_brisched_customer
  ON public.business_recurring_invoice_schedules (customer_id);
-- Cron pickup index: active schedules whose next_due_date has arrived.
CREATE INDEX idx_brisched_cron_due
  ON public.business_recurring_invoice_schedules (next_due_date)
  WHERE status = 'active';

CREATE TRIGGER trg_brisched_updated_at
  BEFORE UPDATE ON public.business_recurring_invoice_schedules
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

CREATE TABLE public.business_recurring_invoice_lines (
    id uuid DEFAULT public.gen_random_uuid() NOT NULL,
    schedule_id uuid NOT NULL REFERENCES public.business_recurring_invoice_schedules(id) ON DELETE CASCADE,
    description text NOT NULL,
    quantity numeric(10,2) DEFAULT 1 NOT NULL,
    unit_price numeric(10,2) NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT business_recurring_invoice_lines_pkey PRIMARY KEY (id),
    CONSTRAINT business_recurring_invoice_lines_qty_positive CHECK (quantity > 0),
    CONSTRAINT business_recurring_invoice_lines_price_nonneg CHECK (unit_price >= 0)
);
CREATE INDEX idx_brilines_schedule
  ON public.business_recurring_invoice_lines (schedule_id, sort_order);

-- Reverse linkage: each generated invoice knows its parent schedule.
ALTER TABLE public.business_invoices
  ADD COLUMN source_recurring_schedule_id uuid
    REFERENCES public.business_recurring_invoice_schedules(id) ON DELETE SET NULL;
CREATE INDEX idx_business_invoices_source_recurring
  ON public.business_invoices (source_recurring_schedule_id)
  WHERE source_recurring_schedule_id IS NOT NULL;

COMMENT ON TABLE public.business_recurring_invoice_schedules IS
  'S505 recurring invoice schedules. Cron generates a draft (or auto-sent) invoice each cycle by copying the lines template.';
COMMENT ON TABLE public.business_recurring_invoice_lines IS
  'S505 line item template for a recurring invoice schedule. Cloned into business_invoice_lines on each cycle.';
