-- S90 / DEFERRED Item 10: utility billing subsystem.
--
-- Adds the utility_bills table that closes the loop on the existing
-- utility scaffolding (utility_meters + utility_meter_readings +
-- utility_meter_units + lease_utility_responsibilities +
-- lease_utility_assignments). Pre-S90 the routes/utility.ts /bills
-- endpoint queried this table and the table didn't exist.
--
-- One bill per (meter, unit, cycle) — UNIQUE constraint backstops the
-- generation engine's idempotency. Re-running generation for the same
-- cycle is safe.
--
-- Snapshot fields (allocation_method, allocation_basis, rate_per_unit,
-- base_fee_share) freeze the meter config + math at generation time so
-- a later meter rate change can't retroactively rewrite historical
-- bills. Same posture as the auto_friday payout snapshots in S66.
--
-- payment_id is nullable: the rent-flow integration (rolling utility
-- charges into the next rent collection) is a separate session. Bills
-- exist before they get paid; the FK lights up when a payment row
-- absorbs the charge.

CREATE TABLE utility_bills (
    id                   uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    meter_id             uuid NOT NULL REFERENCES utility_meters(id) ON DELETE RESTRICT,
    unit_id              uuid NOT NULL REFERENCES units(id) ON DELETE RESTRICT,
    tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
    lease_id             uuid NOT NULL REFERENCES leases(id) ON DELETE RESTRICT,
    landlord_id          uuid NOT NULL REFERENCES landlords(id) ON DELETE RESTRICT,

    billing_cycle_month  date NOT NULL,  -- 1st of month covered

    -- Math snapshot (frozen at generation time).
    usage_amount         numeric(12,4),               -- units consumed (NULL for RUBS)
    allocation_method    text,                        -- snapshot of meter.billing_method
    allocation_basis     numeric(12,4),               -- what we divided by (sqft, occupants, etc)
    rate_per_unit        numeric(10,4),               -- snapshot of meter.rate_per_unit
    base_fee_share       numeric(10,2) NOT NULL DEFAULT 0,
    charge_amount        numeric(10,2) NOT NULL,

    status               text NOT NULL DEFAULT 'unbilled',
    billed_at            timestamp with time zone,
    paid_at              timestamp with time zone,

    -- Set when the bill rolls into a rent payment (deferred wiring).
    payment_id           uuid REFERENCES payments(id) ON DELETE SET NULL,

    notes                text,
    created_at           timestamp with time zone NOT NULL DEFAULT now(),
    updated_at           timestamp with time zone NOT NULL DEFAULT now(),

    CONSTRAINT utility_bills_status_check
      CHECK (status = ANY (ARRAY['unbilled','billed','paid','disputed','void'])),
    CONSTRAINT utility_bills_one_per_meter_unit_cycle
      UNIQUE (meter_id, unit_id, billing_cycle_month)
);

CREATE INDEX idx_utility_bills_landlord_cycle
  ON utility_bills(landlord_id, billing_cycle_month DESC);
CREATE INDEX idx_utility_bills_tenant_cycle
  ON utility_bills(tenant_id, billing_cycle_month DESC);
CREATE INDEX idx_utility_bills_status_unbilled
  ON utility_bills(status, billing_cycle_month)
  WHERE status = 'unbilled';
