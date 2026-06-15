-- S498: GAM for Business — vehicles + work orders (mechanic vertical).
--
-- Four new tables scoped per business:
--
--   business_customer_vehicles      — VIN-keyed vehicle linked to a customer
--   business_work_orders            — job header (customer, vehicle, status)
--   business_work_order_lines       — labor or part lines
--   business_work_order_seq         — per-business WO-NNNNNN sequence
--
-- Design notes:
--
-- (1) VIN is captured per-business — two mechanics in the GAM ecosystem
--     can each have their own row for the same VIN. The cross-mechanic
--     vehicle history surface (so a customer's repair history follows
--     them across shops) is a future feature gated on a customer-side
--     portal which is not in launch scope (S492 product decision: option
--     C — design for future, don't build customer portal yet). For now
--     the VIN column is stored + indexed but not joined cross-business.
--
-- (2) Work order lines are typed: 'labor' (hours × rate) or 'part'
--     (linked to a business_inventory_items row, decrements stock on
--     line creation). Labor lines have no item_id; part lines have no
--     description (uses item name snapshot).
--
-- (3) Adding a part line decrements stock and writes a 'used' adjustment
--     to business_inventory_adjustments with reference_type='work_order'.
--     Removing a part line restores stock and writes 'received'.
--
-- (4) "Convert to invoice" creates a business_invoices row + lines from
--     the work order. Linkage stored on business_invoices.source_work_order_id
--     so the WO knows its invoice and vice versa.
--
-- SAFE — additive only, no backfill.

-- ── business_customer_vehicles ────────────────────────────────
CREATE TABLE public.business_customer_vehicles (
    id uuid DEFAULT public.gen_random_uuid() NOT NULL,
    business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
    customer_id uuid NOT NULL REFERENCES public.business_customers(id) ON DELETE CASCADE,
    vin text,                                  -- optional but encouraged; uppercased on insert
    license_plate text,
    license_plate_state text,                  -- two-letter US state (e.g. 'AZ')
    year integer,
    make text,
    model text,
    color text,
    current_mileage integer,
    notes text,                                -- free text: "key in dash compartment", "uses synthetic oil"
    is_active boolean DEFAULT true NOT NULL,
    archived_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT business_customer_vehicles_pkey PRIMARY KEY (id),
    CONSTRAINT business_customer_vehicles_year_range CHECK (
      year IS NULL OR (year >= 1900 AND year <= 2200)
    ),
    CONSTRAINT business_customer_vehicles_mileage_nonneg CHECK (
      current_mileage IS NULL OR current_mileage >= 0
    ),
    -- VIN must be unique per business if set (two customers don't share
    -- the same vehicle at the same shop). Cross-business sharing is
    -- intentional — VIN can repeat across businesses.
    CONSTRAINT business_customer_vehicles_unique_vin UNIQUE (business_id, vin)
);
CREATE INDEX idx_business_customer_vehicles_business
  ON public.business_customer_vehicles (business_id, is_active);
CREATE INDEX idx_business_customer_vehicles_customer
  ON public.business_customer_vehicles (customer_id);
CREATE INDEX idx_business_customer_vehicles_vin
  ON public.business_customer_vehicles (vin) WHERE vin IS NOT NULL;

CREATE TRIGGER trg_business_customer_vehicles_updated_at
  BEFORE UPDATE ON public.business_customer_vehicles
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ── business_work_orders ──────────────────────────────────────
CREATE TABLE public.business_work_orders (
    id uuid DEFAULT public.gen_random_uuid() NOT NULL,
    business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
    -- Per-business sequential identifier: WO-NNNNNN
    wo_number text NOT NULL,
    customer_id uuid NOT NULL REFERENCES public.business_customers(id) ON DELETE RESTRICT,
    vehicle_id uuid REFERENCES public.business_customer_vehicles(id) ON DELETE SET NULL,
    -- Optional appointment + recurring schedule linkage (work order
    -- created from a scheduled service).
    appointment_id uuid REFERENCES public.appointments(id) ON DELETE SET NULL,
    -- Workflow
    status text DEFAULT 'open' NOT NULL,
    -- Mileage snapshot at intake (typical mechanic flow).
    intake_mileage integer,
    -- Customer's complaint / requested service (free text).
    complaint text,
    -- Tech assignment.
    assigned_to_user_id uuid REFERENCES public.users(id),
    -- Money snapshot (recomputed on every line change).
    labor_subtotal numeric(10,2) DEFAULT 0 NOT NULL,
    parts_subtotal numeric(10,2) DEFAULT 0 NOT NULL,
    tax_amount numeric(10,2) DEFAULT 0 NOT NULL,
    total_amount numeric(10,2) DEFAULT 0 NOT NULL,
    -- Closeout
    completed_at timestamp with time zone,
    closeout_mileage integer,
    closeout_notes text,
    cancelled_at timestamp with time zone,
    cancel_reason text,
    -- Invoice linkage (set on convert-to-invoice).
    invoice_id uuid REFERENCES public.business_invoices(id) ON DELETE SET NULL,
    created_by_user_id uuid REFERENCES public.users(id),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT business_work_orders_pkey PRIMARY KEY (id),
    CONSTRAINT business_work_orders_status_check CHECK (
      status = ANY (ARRAY[
        'open'::text,
        'in_progress'::text,
        'awaiting_parts'::text,
        'completed'::text,
        'cancelled'::text
      ])
    ),
    CONSTRAINT business_work_orders_mileage_intake_nonneg CHECK (
      intake_mileage IS NULL OR intake_mileage >= 0
    ),
    CONSTRAINT business_work_orders_mileage_closeout_nonneg CHECK (
      closeout_mileage IS NULL OR closeout_mileage >= 0
    ),
    CONSTRAINT business_work_orders_money_nonneg CHECK (
      labor_subtotal >= 0 AND parts_subtotal >= 0
      AND tax_amount >= 0 AND total_amount >= 0
    ),
    CONSTRAINT business_work_orders_completed_consistency CHECK (
      (status = 'completed' AND completed_at IS NOT NULL)
      OR (status <> 'completed' AND completed_at IS NULL)
    ),
    CONSTRAINT business_work_orders_cancelled_consistency CHECK (
      (status = 'cancelled' AND cancelled_at IS NOT NULL)
      OR (status <> 'cancelled' AND cancelled_at IS NULL)
    ),
    CONSTRAINT business_work_orders_unique_number UNIQUE (business_id, wo_number)
);
CREATE INDEX idx_business_work_orders_business
  ON public.business_work_orders (business_id, status, created_at DESC);
CREATE INDEX idx_business_work_orders_customer
  ON public.business_work_orders (customer_id);
CREATE INDEX idx_business_work_orders_vehicle
  ON public.business_work_orders (vehicle_id) WHERE vehicle_id IS NOT NULL;
CREATE INDEX idx_business_work_orders_appointment
  ON public.business_work_orders (appointment_id) WHERE appointment_id IS NOT NULL;
CREATE INDEX idx_business_work_orders_invoice
  ON public.business_work_orders (invoice_id) WHERE invoice_id IS NOT NULL;
CREATE INDEX idx_business_work_orders_assigned
  ON public.business_work_orders (assigned_to_user_id) WHERE assigned_to_user_id IS NOT NULL;

CREATE TRIGGER trg_business_work_orders_updated_at
  BEFORE UPDATE ON public.business_work_orders
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ── business_work_order_lines ─────────────────────────────────
-- Labor lines: line_type='labor', item_id=NULL, description=task name,
-- quantity=hours, unit_price=hourly rate.
--
-- Part lines: line_type='part', item_id=ref to business_inventory_items,
-- description snapshots the item name, quantity=units sold, unit_price
-- snapshots item.sell_price. Adding a part line decrements stock_qty
-- and writes a 'used' inventory adjustment row.
CREATE TABLE public.business_work_order_lines (
    id uuid DEFAULT public.gen_random_uuid() NOT NULL,
    work_order_id uuid NOT NULL REFERENCES public.business_work_orders(id) ON DELETE CASCADE,
    line_type text NOT NULL,
    item_id uuid REFERENCES public.business_inventory_items(id) ON DELETE CASCADE,
    description text NOT NULL,
    quantity numeric(10,2) NOT NULL,            -- units OR hours
    unit_price numeric(10,2) NOT NULL,
    tax_rate numeric(5,4) DEFAULT 0 NOT NULL,    -- per-line tax (parts often have item-level tax)
    line_subtotal numeric(10,2) NOT NULL,
    line_tax numeric(10,2) DEFAULT 0 NOT NULL,
    line_total numeric(10,2) NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT business_work_order_lines_pkey PRIMARY KEY (id),
    CONSTRAINT business_work_order_lines_type_check CHECK (
      line_type = ANY (ARRAY['labor'::text, 'part'::text, 'fee'::text])
    ),
    CONSTRAINT business_work_order_lines_qty_positive CHECK (quantity > 0),
    CONSTRAINT business_work_order_lines_price_nonneg CHECK (unit_price >= 0),
    CONSTRAINT business_work_order_lines_tax_range CHECK (tax_rate >= 0 AND tax_rate < 1),
    -- Part lines must have item_id; labor/fee lines must not.
    CONSTRAINT business_work_order_lines_part_has_item CHECK (
      (line_type = 'part' AND item_id IS NOT NULL)
      OR (line_type <> 'part' AND item_id IS NULL)
    )
);
CREATE INDEX idx_business_work_order_lines_wo
  ON public.business_work_order_lines (work_order_id, sort_order);
CREATE INDEX idx_business_work_order_lines_item
  ON public.business_work_order_lines (item_id) WHERE item_id IS NOT NULL;

-- ── Per-business WO sequence ──────────────────────────────────
CREATE TABLE public.business_work_order_sequences (
    business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
    next_number integer DEFAULT 1 NOT NULL,
    CONSTRAINT business_work_order_sequences_pkey PRIMARY KEY (business_id),
    CONSTRAINT business_work_order_sequences_next_positive CHECK (next_number > 0)
);

-- ── Reverse linkage from invoices ─────────────────────────────
ALTER TABLE public.business_invoices
  ADD COLUMN source_work_order_id uuid REFERENCES public.business_work_orders(id) ON DELETE SET NULL;
CREATE INDEX idx_business_invoices_source_wo
  ON public.business_invoices (source_work_order_id) WHERE source_work_order_id IS NOT NULL;

COMMENT ON TABLE public.business_customer_vehicles IS
  'S498 per-business vehicle records keyed by VIN. Linked to a business_customers row. Cross-business shared-history surface is a future feature gated on customer-side portal.';
COMMENT ON TABLE public.business_work_orders IS
  'S498 mechanic-vertical work-order header. Customer + optional vehicle + status workflow. Convert-to-invoice creates a business_invoices row linked via invoice_id (and reverse via business_invoices.source_work_order_id).';
COMMENT ON TABLE public.business_work_order_lines IS
  'S498 work-order line items. line_type labor (hours × rate) | part (links to inventory + decrements stock on add) | fee (flat).';
