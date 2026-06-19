-- S513 (J): GAM for Business — discounts & coupons.
--
-- Owner-created discount codes (percent or flat-dollar) applied to a POS
-- sale or an invoice. Optional usage cap + active window.
--
-- This migration bundles three inseparable parts of the one feature:
--   1. Add 'discounts' to the businesses.enabled_features CHECK catalog.
--   2. Create business_discount_codes (the catalog of codes).
--   3. Add discount_code_id + discount_amount snapshot columns to
--      business_pos_transactions and business_invoices.
--
-- Money model (applied PRE-TAX to the subtotal):
--   discount_amount = percent → round(subtotal * value/100)
--                     fixed   → min(value, subtotal)
--   The discount reduces the taxable base. POS scales the per-line tax
--   total by (subtotal - discount)/subtotal (mathematically identical to
--   a proportional per-line discount). Invoices recompute order-level tax
--   on the discounted subtotal.
--
-- SAFE — additive only. discount_amount defaults 0, discount_code_id is
-- nullable; existing rows carried no discount, no backfill needed.

-- ── 1. feature catalog CHECK ──────────────────────────────────
ALTER TABLE public.businesses
  DROP CONSTRAINT IF EXISTS businesses_enabled_features_check;
ALTER TABLE public.businesses
  ADD CONSTRAINT businesses_enabled_features_check CHECK (
    enabled_features <@ ARRAY[
      'customers'::text, 'staff'::text, 'recurring_schedules'::text,
      'appointments'::text, 'routing'::text, 'pos'::text,
      'inventory'::text, 'work_orders'::text, 'customer_vehicles'::text,
      'invoicing'::text, 'payments'::text, 'quotes'::text,
      'discounts'::text
    ]
  );

-- ── 2. business_discount_codes ────────────────────────────────
CREATE TABLE public.business_discount_codes (
    id uuid DEFAULT public.gen_random_uuid() NOT NULL,
    business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
    -- Customer-facing code, unique per business (stored upper-cased by
    -- the API so lookups are case-insensitive).
    code text NOT NULL,
    description text,
    -- percent | fixed (mirrors BUSINESS_DISCOUNT_TYPES in shared).
    discount_type text NOT NULL,
    -- percent: a percentage 0–100 (15.00 = 15%). fixed: flat dollars.
    discount_value numeric(10,2) NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    -- Optional active window. NULL = no bound on that side.
    starts_at timestamp with time zone,
    expires_at timestamp with time zone,
    -- Optional cap on total uses. NULL = unlimited.
    max_redemptions integer,
    redemption_count integer DEFAULT 0 NOT NULL,
    created_by uuid REFERENCES public.users(id),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT business_discount_codes_pkey PRIMARY KEY (id),
    CONSTRAINT business_discount_codes_type_check CHECK (
      discount_type = ANY (ARRAY['percent'::text, 'fixed'::text])
    ),
    CONSTRAINT business_discount_codes_value_nonneg CHECK (discount_value >= 0),
    -- A percent discount can't exceed 100%.
    CONSTRAINT business_discount_codes_percent_range CHECK (
      discount_type <> 'percent' OR discount_value <= 100
    ),
    CONSTRAINT business_discount_codes_redemptions_nonneg CHECK (redemption_count >= 0),
    CONSTRAINT business_discount_codes_max_redemptions_positive CHECK (
      max_redemptions IS NULL OR max_redemptions > 0
    ),
    CONSTRAINT business_discount_codes_window CHECK (
      starts_at IS NULL OR expires_at IS NULL OR expires_at > starts_at
    ),
    CONSTRAINT business_discount_codes_unique_code UNIQUE (business_id, code)
);
CREATE INDEX idx_business_discount_codes_business
  ON public.business_discount_codes (business_id, is_active);

CREATE TRIGGER trg_business_discount_codes_updated_at
  BEFORE UPDATE ON public.business_discount_codes
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

COMMENT ON TABLE public.business_discount_codes IS
  'S513 owner-created discount codes (percent | fixed) applied to POS sales + invoices. redemption_count is bumped at apply time inside the sale/invoice transaction.';

-- ── 3. snapshot columns on the two consumers ──────────────────
ALTER TABLE public.business_pos_transactions
  ADD COLUMN discount_code_id uuid REFERENCES public.business_discount_codes(id) ON DELETE SET NULL,
  ADD COLUMN discount_amount numeric(10,2) DEFAULT 0 NOT NULL;
ALTER TABLE public.business_pos_transactions
  ADD CONSTRAINT business_pos_transactions_discount_nonneg CHECK (discount_amount >= 0);

ALTER TABLE public.business_invoices
  ADD COLUMN discount_code_id uuid REFERENCES public.business_discount_codes(id) ON DELETE SET NULL,
  ADD COLUMN discount_amount numeric(10,2) DEFAULT 0 NOT NULL;
ALTER TABLE public.business_invoices
  ADD CONSTRAINT business_invoices_discount_nonneg CHECK (discount_amount >= 0);

COMMENT ON COLUMN public.business_pos_transactions.discount_amount IS
  'S513 pre-tax discount applied via discount_code_id. subtotal is full price; total_amount = (subtotal - discount_amount) + (scaled) tax_amount.';
COMMENT ON COLUMN public.business_invoices.discount_amount IS
  'S513 pre-tax discount applied via discount_code_id. total_amount = (subtotal - discount_amount) + tax_amount.';
