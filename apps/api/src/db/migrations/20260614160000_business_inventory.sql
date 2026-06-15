-- S496: GAM for Business — inventory schema.
--
-- Three new tables scoped per business (no shared schema with the
-- landlord-side `pos_items` since that's heavily tied to landlord_id +
-- property_id + category_id):
--
--   business_inventory_categories  — optional grouping (parts, supplies, retail)
--   business_inventory_items       — SKUs with stock levels + pricing
--   business_inventory_adjustments — audit trail for stock changes
--
-- Inventory pairs with two features in the catalog:
--   - `pos`         — items are retail SKUs sold through the register
--   - `work_orders` — items are parts consumed on service jobs
-- The `inventory` feature toggle enables the table; the consuming
-- features (pos, work_orders) read from the same set.
--
-- SAFE — additive only, no backfill.

-- ── business_inventory_categories ─────────────────────────────
CREATE TABLE public.business_inventory_categories (
    id uuid DEFAULT public.gen_random_uuid() NOT NULL,
    business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
    name text NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT business_inventory_categories_pkey PRIMARY KEY (id),
    CONSTRAINT business_inventory_categories_unique_name UNIQUE (business_id, name)
);
CREATE INDEX idx_business_inventory_categories_business
  ON public.business_inventory_categories (business_id, sort_order);

-- ── business_inventory_items ──────────────────────────────────
CREATE TABLE public.business_inventory_items (
    id uuid DEFAULT public.gen_random_uuid() NOT NULL,
    business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
    category_id uuid REFERENCES public.business_inventory_categories(id) ON DELETE SET NULL,
    name text NOT NULL,
    sku text,                                   -- optional barcode / external SKU
    description text,
    -- Money
    cost_price numeric(10,2) DEFAULT 0 NOT NULL,
    sell_price numeric(10,2) DEFAULT 0 NOT NULL,
    tax_rate numeric(5,4) DEFAULT 0 NOT NULL,    -- e.g. 0.0875 for 8.75%
    -- Stock
    stock_qty integer DEFAULT 0 NOT NULL,
    stock_min integer DEFAULT 0 NOT NULL,         -- reorder point
    stock_max integer DEFAULT 0 NOT NULL,         -- target on hand
    -- Status
    is_active boolean DEFAULT true NOT NULL,
    archived_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT business_inventory_items_pkey PRIMARY KEY (id),
    CONSTRAINT business_inventory_items_stock_qty_nonneg CHECK (stock_qty >= 0),
    CONSTRAINT business_inventory_items_stock_min_nonneg CHECK (stock_min >= 0),
    CONSTRAINT business_inventory_items_stock_max_nonneg CHECK (stock_max >= 0),
    CONSTRAINT business_inventory_items_cost_nonneg CHECK (cost_price >= 0),
    CONSTRAINT business_inventory_items_sell_nonneg CHECK (sell_price >= 0),
    CONSTRAINT business_inventory_items_tax_range CHECK (tax_rate >= 0 AND tax_rate < 1),
    -- SKU unique per business when set.
    CONSTRAINT business_inventory_items_unique_sku UNIQUE (business_id, sku)
);
CREATE INDEX idx_business_inventory_items_business
  ON public.business_inventory_items (business_id, is_active, name);
CREATE INDEX idx_business_inventory_items_category
  ON public.business_inventory_items (category_id);
-- Partial index for the "low stock" query — items where stock_qty <= stock_min.
CREATE INDEX idx_business_inventory_items_low_stock
  ON public.business_inventory_items (business_id)
  WHERE is_active = TRUE AND stock_qty <= stock_min AND stock_min > 0;

CREATE TRIGGER trg_business_inventory_items_updated_at
  BEFORE UPDATE ON public.business_inventory_items
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ── business_inventory_adjustments ────────────────────────────
-- Append-only audit trail. Every stock_qty change writes a row here so
-- the operator can answer "how did we end up with 12 widgets?"
CREATE TABLE public.business_inventory_adjustments (
    id uuid DEFAULT public.gen_random_uuid() NOT NULL,
    business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
    item_id uuid NOT NULL REFERENCES public.business_inventory_items(id) ON DELETE CASCADE,
    adjustment_type text NOT NULL,
    quantity_delta integer NOT NULL,             -- signed: positive = stock in, negative = stock out
    stock_qty_after integer NOT NULL,            -- snapshot of stock_qty AFTER the adjustment
    notes text,
    actor_user_id uuid REFERENCES public.users(id),
    -- Optional refs for future POS + work-order integrations.
    reference_type text,                         -- 'pos_transaction' | 'work_order' | 'manual' | 'count'
    reference_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT business_inventory_adjustments_pkey PRIMARY KEY (id),
    CONSTRAINT business_inventory_adjustments_type_check CHECK (
      adjustment_type = ANY (ARRAY[
        'received'::text,
        'sold'::text,
        'used'::text,
        'shrinkage'::text,
        'count'::text,
        'manual'::text
      ])
    ),
    CONSTRAINT business_inventory_adjustments_stock_after_nonneg CHECK (stock_qty_after >= 0)
);
CREATE INDEX idx_business_inventory_adjustments_item
  ON public.business_inventory_adjustments (item_id, created_at DESC);
CREATE INDEX idx_business_inventory_adjustments_business
  ON public.business_inventory_adjustments (business_id, created_at DESC);

COMMENT ON TABLE public.business_inventory_items IS
  'S496 business-portal inventory items. Per-business SKUs with stock levels + pricing. Pairs with POS (retail sales) and Work Orders (parts consumed on service jobs).';
COMMENT ON TABLE public.business_inventory_adjustments IS
  'S496 append-only audit trail for inventory stock changes. Every stock_qty mutation writes a row here.';
