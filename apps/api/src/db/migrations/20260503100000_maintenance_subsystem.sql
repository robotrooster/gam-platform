-- S89 / DEFERRED Item 5: maintenance subsystem.
--
-- Five tables backing apps/api/src/routes/maintenance-portal.ts. Routes
-- were S81-gated by sub-permission but throw at runtime today because
-- the underlying tables don't exist. This migration makes them real
-- with the column shape the routes already assume.
--
--   shifts                — clock-in/clock-out timer per maintenance worker
--   daily_tasks           — landlord-defined daily checklist items
--   parts_inventory       — landlord-owned spare parts catalog
--   purchase_requests     — worker-initiated supply requests, landlord approves
--   scheduled_maintenance — recurring preventive maintenance (HVAC, etc)
--
-- Confirmed pre-launch at S60 (Item 5).
--
-- Idempotency / safety:
--   - shifts has a partial UNIQUE on (user_id) WHERE clocked_out_at IS NULL
--     so the route's "already clocked in" check has hard backstop. A worker
--     can have many historical shifts but only one open at a time.
--   - purchase_requests.status CHECK matches the route's flip values
--     (pending → approved | denied).
--   - scheduled_maintenance.recurrence CHECK matches the recurrenceMap in
--     maintenance-portal.ts:198-200 (weekly/monthly/quarterly/biannual/annual).

CREATE TABLE shifts (
    id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    landlord_id     uuid NOT NULL REFERENCES landlords(id) ON DELETE RESTRICT,

    clocked_in_at   timestamp with time zone NOT NULL DEFAULT now(),
    clocked_out_at  timestamp with time zone,
    notes           text,

    created_at      timestamp with time zone NOT NULL DEFAULT now()
);

-- One open shift per user. Historical shifts are unbounded (NULL filter).
CREATE UNIQUE INDEX shifts_one_open_per_user
  ON shifts(user_id)
  WHERE clocked_out_at IS NULL;

CREATE INDEX idx_shifts_landlord_open
  ON shifts(landlord_id, clocked_in_at ASC)
  WHERE clocked_out_at IS NULL;

CREATE TABLE daily_tasks (
    id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    landlord_id     uuid NOT NULL REFERENCES landlords(id) ON DELETE RESTRICT,

    title           text NOT NULL,
    description     text,
    assigned_to     uuid REFERENCES users(id) ON DELETE SET NULL,

    due_date        date,
    recurrence      text NOT NULL DEFAULT 'none',

    completed       boolean NOT NULL DEFAULT FALSE,
    completed_at    timestamp with time zone,
    completed_by    uuid REFERENCES users(id) ON DELETE SET NULL,

    created_at      timestamp with time zone NOT NULL DEFAULT now(),
    updated_at      timestamp with time zone NOT NULL DEFAULT now(),

    CONSTRAINT daily_tasks_recurrence_check
      CHECK (recurrence = ANY (ARRAY['none','daily','weekly','monthly']))
);

CREATE INDEX idx_daily_tasks_landlord_today
  ON daily_tasks(landlord_id, completed, due_date);

CREATE TABLE parts_inventory (
    id            uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    landlord_id   uuid NOT NULL REFERENCES landlords(id) ON DELETE RESTRICT,

    name          text NOT NULL,
    description   text,
    sku           text,

    quantity      integer NOT NULL DEFAULT 0,
    min_quantity  integer NOT NULL DEFAULT 0,
    unit          text NOT NULL DEFAULT 'each',
    location      text,
    cost          numeric(10,2),

    created_at    timestamp with time zone NOT NULL DEFAULT now(),
    updated_at    timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX idx_parts_inventory_landlord_name
  ON parts_inventory(landlord_id, name);

CREATE TABLE purchase_requests (
    id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    landlord_id     uuid NOT NULL REFERENCES landlords(id) ON DELETE RESTRICT,
    requested_by    uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    approved_by     uuid REFERENCES users(id) ON DELETE SET NULL,
    approved_at     timestamp with time zone,

    -- nullable: ad-hoc supply runs aren't tied to a work order
    work_order_id   uuid REFERENCES maintenance_requests(id) ON DELETE SET NULL,

    items           jsonb NOT NULL DEFAULT '[]'::jsonb,
    notes           text,
    total_estimate  numeric(10,2),
    budget_limit    numeric(10,2),

    status          text NOT NULL DEFAULT 'pending',

    created_at      timestamp with time zone NOT NULL DEFAULT now(),

    CONSTRAINT purchase_requests_status_check
      CHECK (status = ANY (ARRAY['pending','approved','denied']))
);

CREATE INDEX idx_purchase_requests_landlord_status
  ON purchase_requests(landlord_id, status, created_at DESC);

CREATE INDEX idx_purchase_requests_work_order
  ON purchase_requests(work_order_id) WHERE work_order_id IS NOT NULL;

CREATE TABLE scheduled_maintenance (
    id               uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    landlord_id      uuid NOT NULL REFERENCES landlords(id) ON DELETE RESTRICT,

    title            text NOT NULL,
    description      text,
    recurrence       text NOT NULL,

    property_id      uuid REFERENCES properties(id) ON DELETE SET NULL,
    unit_id          uuid REFERENCES units(id) ON DELETE SET NULL,
    assigned_to      uuid REFERENCES users(id) ON DELETE SET NULL,

    next_due         date,
    last_completed   date,
    estimated_hours  numeric(6,2),

    created_at       timestamp with time zone NOT NULL DEFAULT now(),
    updated_at       timestamp with time zone NOT NULL DEFAULT now(),

    CONSTRAINT scheduled_maintenance_recurrence_check
      CHECK (recurrence = ANY (ARRAY['weekly','monthly','quarterly','biannual','annual']))
);

CREATE INDEX idx_scheduled_maintenance_landlord_due
  ON scheduled_maintenance(landlord_id, next_due ASC);
