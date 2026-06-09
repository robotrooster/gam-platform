-- S93 / DEFERRED Item 14 (schema): POS subsystem.
--
-- 13 tables backing apps/api/src/routes/pos.ts. Routes were S81-gated
-- by sub-permission but throw at runtime today because none of these
-- tables exist. This migration makes the column shape match what the
-- route INSERTs/UPDATEs/SELECTs already assume.
--
-- Confirmed launch tier per S60 — RV park use case (propane refills,
-- dump-station fees, walk-up amenity sales). Handles tenant charge-
-- account flow AND non-tenant (cash/card walk-up) flow per S60 lock.
--
-- This is schema only. Receipt printing, end-of-day reconciliation,
-- multi-terminal sync — all product polish work that lives outside
-- the database. Same recipe as work-trade S88 / maintenance S89 /
-- master-schedule S92.
--
-- Idempotency / safety:
--   - pos_purchase_orders has UNIQUE(landlord_id, po_number) so the
--     route's auto-generated PO numbers can't collide across re-runs.
--   - pos_discounts has partial UNIQUE(landlord_id, code) WHERE code
--     IS NOT NULL — landlords can have many "no code" promotional
--     discounts but a coded discount is unique per landlord.

-- ── CATALOG: VENDORS, ITEMS, CATEGORIES, VARIANTS, TAXES, DISCOUNTS ──

CREATE TABLE pos_vendors (
    id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    landlord_id     uuid NOT NULL REFERENCES landlords(id) ON DELETE RESTRICT,
    name            text NOT NULL,
    contact_name    text,
    email           text,
    phone           text,
    address         text,
    lead_time_days  integer NOT NULL DEFAULT 3,
    notes           text,
    is_active       boolean NOT NULL DEFAULT TRUE,
    created_at      timestamp with time zone NOT NULL DEFAULT now(),
    updated_at      timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX idx_pos_vendors_landlord ON pos_vendors(landlord_id, name) WHERE is_active = TRUE;

CREATE TABLE pos_categories (
    id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    landlord_id     uuid NOT NULL REFERENCES landlords(id) ON DELETE RESTRICT,
    name            text NOT NULL,
    icon            text,
    sort_order      integer NOT NULL DEFAULT 0,
    is_active       boolean NOT NULL DEFAULT TRUE,
    created_at      timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX idx_pos_categories_landlord ON pos_categories(landlord_id, sort_order, name) WHERE is_active = TRUE;

CREATE TABLE pos_items (
    id                   uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    landlord_id          uuid NOT NULL REFERENCES landlords(id) ON DELETE RESTRICT,
    name                 text NOT NULL,
    category             text NOT NULL DEFAULT 'misc',
    icon                 text,
    cost_price           numeric(10,2) NOT NULL DEFAULT 0,
    sell_price           numeric(10,2) NOT NULL,
    margin_pct           numeric(6,2),
    tax_rate             numeric(5,4) NOT NULL DEFAULT 0,
    charge_eligible      boolean NOT NULL DEFAULT TRUE,
    stock_qty            integer NOT NULL DEFAULT 0,
    stock_min            integer NOT NULL DEFAULT 0,
    stock_max            integer NOT NULL DEFAULT 0,
    vendor_id            uuid REFERENCES pos_vendors(id) ON DELETE SET NULL,
    shelf_label_enabled  boolean NOT NULL DEFAULT TRUE,
    has_variants         boolean NOT NULL DEFAULT FALSE,
    is_active            boolean NOT NULL DEFAULT TRUE,
    created_at           timestamp with time zone NOT NULL DEFAULT now(),
    updated_at           timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX idx_pos_items_landlord ON pos_items(landlord_id, category, name) WHERE is_active = TRUE;
CREATE INDEX idx_pos_items_low_stock ON pos_items(landlord_id, stock_qty)
  WHERE is_active = TRUE AND stock_qty <= stock_min AND stock_max < 999;

CREATE TABLE pos_item_variants (
    id           uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    item_id      uuid NOT NULL REFERENCES pos_items(id) ON DELETE CASCADE,
    name         text NOT NULL,
    cost_price   numeric(10,2) NOT NULL DEFAULT 0,
    sell_price   numeric(10,2) NOT NULL,
    stock_qty    integer NOT NULL DEFAULT 0,
    stock_min    integer NOT NULL DEFAULT 5,
    sort_order   integer NOT NULL DEFAULT 0,
    is_active    boolean NOT NULL DEFAULT TRUE,
    created_at   timestamp with time zone NOT NULL DEFAULT now(),
    updated_at   timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX idx_pos_item_variants_item ON pos_item_variants(item_id, sort_order, sell_price) WHERE is_active = TRUE;

CREATE TABLE pos_price_history (
    id           uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    item_id      uuid NOT NULL REFERENCES pos_items(id) ON DELETE CASCADE,
    old_price    numeric(10,2),
    new_price    numeric(10,2),
    old_cost     numeric(10,2),
    new_cost     numeric(10,2),
    changed_by   uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at   timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX idx_pos_price_history_item ON pos_price_history(item_id, created_at DESC);

CREATE TABLE pos_tax_rates (
    id           uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    landlord_id  uuid NOT NULL REFERENCES landlords(id) ON DELETE RESTRICT,
    name         text NOT NULL,
    rate         numeric(7,4) NOT NULL,
    tax_type     text NOT NULL,
    applies_to   text[] NOT NULL DEFAULT ARRAY['all'::text],
    is_active    boolean NOT NULL DEFAULT TRUE,
    created_at   timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX idx_pos_tax_rates_landlord ON pos_tax_rates(landlord_id, tax_type, name) WHERE is_active = TRUE;

CREATE TABLE pos_discounts (
    id           uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    landlord_id  uuid NOT NULL REFERENCES landlords(id) ON DELETE RESTRICT,
    name         text NOT NULL,
    type         text NOT NULL,
    value        numeric(10,2) NOT NULL,
    code         text,
    is_active    boolean NOT NULL DEFAULT TRUE,
    created_at   timestamp with time zone NOT NULL DEFAULT now(),

    CONSTRAINT pos_discounts_type_check CHECK (type = ANY (ARRAY['percent','fixed','bogo','other']))
);
CREATE INDEX idx_pos_discounts_landlord ON pos_discounts(landlord_id, name) WHERE is_active = TRUE;
-- Coded discounts unique per landlord; uncoded promos unbounded.
CREATE UNIQUE INDEX pos_discounts_code_uniq ON pos_discounts(landlord_id, code) WHERE code IS NOT NULL;

-- ── TRANSACTIONS, LINE ITEMS, REFUNDS ──

CREATE TABLE pos_transactions (
    id                uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    landlord_id       uuid NOT NULL REFERENCES landlords(id) ON DELETE RESTRICT,
    tenant_id         uuid REFERENCES tenants(id) ON DELETE SET NULL,
    cashier_id        uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,

    payment_method    text NOT NULL,
    subtotal          numeric(10,2) NOT NULL,
    tax_amount        numeric(10,2) NOT NULL DEFAULT 0,
    surcharge         numeric(10,2) NOT NULL DEFAULT 0,
    total             numeric(10,2) NOT NULL,
    change_given      numeric(10,2) NOT NULL DEFAULT 0,
    platform_fee      numeric(10,2) NOT NULL DEFAULT 0,

    status            text NOT NULL DEFAULT 'completed',
    refund_amount     numeric(10,2) NOT NULL DEFAULT 0,
    refunded_at       timestamp with time zone,
    void_reason       text,

    created_at        timestamp with time zone NOT NULL DEFAULT now(),

    CONSTRAINT pos_transactions_payment_method_check
      CHECK (payment_method = ANY (ARRAY['cash','card','charge'])),
    CONSTRAINT pos_transactions_status_check
      CHECK (status = ANY (ARRAY['completed','refunded','partial_refund','voided']))
);
CREATE INDEX idx_pos_transactions_landlord_date ON pos_transactions(landlord_id, created_at DESC);
CREATE INDEX idx_pos_transactions_tenant ON pos_transactions(tenant_id, created_at DESC) WHERE tenant_id IS NOT NULL;

CREATE TABLE pos_transaction_items (
    id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    transaction_id  uuid NOT NULL REFERENCES pos_transactions(id) ON DELETE CASCADE,
    -- Nullable: walk-up adhoc lines that don't reference a catalog item.
    item_id         uuid REFERENCES pos_items(id) ON DELETE SET NULL,
    -- Snapshots so historical receipts survive item deletes / renames.
    item_name       text NOT NULL,
    item_category   text,
    qty             numeric(10,3) NOT NULL,
    unit_price      numeric(10,2) NOT NULL,
    cost_price      numeric(10,2) NOT NULL DEFAULT 0,
    tax_rate        numeric(5,4) NOT NULL DEFAULT 0,
    subtotal        numeric(10,2) NOT NULL,
    created_at      timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX idx_pos_transaction_items_tx ON pos_transaction_items(transaction_id);
CREATE INDEX idx_pos_transaction_items_item ON pos_transaction_items(item_id) WHERE item_id IS NOT NULL;

CREATE TABLE pos_refunds (
    id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    transaction_id  uuid NOT NULL REFERENCES pos_transactions(id) ON DELETE RESTRICT,
    landlord_id     uuid NOT NULL REFERENCES landlords(id) ON DELETE RESTRICT,
    amount          numeric(10,2) NOT NULL,
    reason          text,
    items           jsonb,
    refund_method   text NOT NULL,
    created_at      timestamp with time zone NOT NULL DEFAULT now(),

    CONSTRAINT pos_refunds_method_check
      CHECK (refund_method = ANY (ARRAY['cash','card','charge']))
);
CREATE INDEX idx_pos_refunds_landlord_date ON pos_refunds(landlord_id, created_at DESC);
CREATE INDEX idx_pos_refunds_tx ON pos_refunds(transaction_id);

-- ── INVENTORY LOG (audit trail for all stock_qty changes) ──

CREATE TABLE pos_inventory_log (
    id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    item_id         uuid NOT NULL REFERENCES pos_items(id) ON DELETE CASCADE,
    landlord_id     uuid NOT NULL REFERENCES landlords(id) ON DELETE RESTRICT,
    change_qty      integer NOT NULL,
    reason          text NOT NULL,
    notes           text,
    -- Generic FK pointer: holds tx id (for sale), po id (for po_received),
    -- or NULL (for adjustment). Not enforced — by design, since it points
    -- at multiple parent tables.
    reference_id    uuid,
    stock_before    integer NOT NULL,
    stock_after     integer NOT NULL,
    created_at      timestamp with time zone NOT NULL DEFAULT now(),

    CONSTRAINT pos_inventory_log_reason_check
      CHECK (reason = ANY (ARRAY['adjustment','sale','po_received','return','manual','other']))
);
CREATE INDEX idx_pos_inventory_log_item_date ON pos_inventory_log(item_id, created_at DESC);
CREATE INDEX idx_pos_inventory_log_landlord_date ON pos_inventory_log(landlord_id, created_at DESC);

-- ── PURCHASE ORDERS ──

CREATE TABLE pos_purchase_orders (
    id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    landlord_id     uuid NOT NULL REFERENCES landlords(id) ON DELETE RESTRICT,
    vendor_id       uuid NOT NULL REFERENCES pos_vendors(id) ON DELETE RESTRICT,
    status          text NOT NULL DEFAULT 'draft',
    po_number       text NOT NULL,
    notes           text,
    expected_date   date,
    subtotal        numeric(10,2) NOT NULL DEFAULT 0,

    approved_at     timestamp with time zone,
    sent_at         timestamp with time zone,
    received_at     timestamp with time zone,

    created_at      timestamp with time zone NOT NULL DEFAULT now(),
    updated_at      timestamp with time zone NOT NULL DEFAULT now(),

    CONSTRAINT pos_purchase_orders_status_check
      CHECK (status = ANY (ARRAY['draft','approved','sent','received','cancelled'])),
    CONSTRAINT pos_purchase_orders_po_number_uniq
      UNIQUE (landlord_id, po_number)
);
CREATE INDEX idx_pos_purchase_orders_landlord ON pos_purchase_orders(landlord_id, created_at DESC);
CREATE INDEX idx_pos_purchase_orders_vendor ON pos_purchase_orders(vendor_id, status);

CREATE TABLE pos_purchase_order_items (
    id           uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    po_id        uuid NOT NULL REFERENCES pos_purchase_orders(id) ON DELETE CASCADE,
    item_id      uuid REFERENCES pos_items(id) ON DELETE SET NULL,
    item_name    text NOT NULL,
    qty_ordered  numeric(10,3) NOT NULL,
    unit_cost    numeric(10,2) NOT NULL,
    subtotal     numeric(10,2) NOT NULL,
    created_at   timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX idx_pos_purchase_order_items_po ON pos_purchase_order_items(po_id);
