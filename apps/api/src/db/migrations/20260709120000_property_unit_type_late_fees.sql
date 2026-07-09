-- Per-UNIT-TYPE late fees (Nic, S535).
--
-- Late fees are a property-level policy (anti-discrimination: identical
-- terms for every tenant, locked into each drafted lease at creation —
-- the signed snapshot stays the billing source, so existing leases keep
-- their signed terms and age onto the current policy at renewal). The
-- landlord may set DIFFERENT late fees per unit TYPE — an RV spot vs.
-- an apartment vs. storage — because the legal distinction is the unit
-- class, never the tenant. Pairs with per-unit-type lease templates:
-- the unit's type pulls both the correct template AND the correct fee
-- policy automatically at drafting.
--
-- An override row REPLACES the property default wholesale for its
-- unit_type (grace + initial required; accrual/cap optional exactly as
-- on properties). Resolution: unit_type row wins, else the property
-- default (services/lateFeePolicy.ts).
--
-- unit_type CHECK mirrors shared UNIT_TYPES.
-- No backfill needed: brand-new table; absence = property default.

CREATE TABLE property_unit_type_late_fees (
    id                      uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    property_id             uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    unit_type               text NOT NULL CHECK (unit_type IN
                              ('apartment','single_family','rv_spot','mobile_home','storage','commercial')),
    late_fee_grace_days     integer NOT NULL DEFAULT 5 CHECK (late_fee_grace_days >= 0),
    late_fee_initial_amount numeric(10,2) NOT NULL CHECK (late_fee_initial_amount >= 0),
    late_fee_initial_type   text NOT NULL CHECK (late_fee_initial_type IN ('flat','percent_of_rent')),
    late_fee_accrual_amount numeric(10,2) CHECK (late_fee_accrual_amount IS NULL OR late_fee_accrual_amount >= 0),
    late_fee_accrual_type   text CHECK (late_fee_accrual_type IS NULL OR late_fee_accrual_type IN ('flat','percent_of_rent')),
    late_fee_accrual_period text CHECK (late_fee_accrual_period IS NULL OR late_fee_accrual_period IN ('daily','weekly','monthly')),
    late_fee_cap_amount     numeric(10,2) CHECK (late_fee_cap_amount IS NULL OR late_fee_cap_amount >= 0),
    late_fee_cap_type       text CHECK (late_fee_cap_type IS NULL OR late_fee_cap_type IN ('flat','percent_of_rent')),
    created_at              timestamptz NOT NULL DEFAULT now(),
    updated_at              timestamptz NOT NULL DEFAULT now(),
    UNIQUE (property_id, unit_type)
);

CREATE INDEX idx_put_late_fees_property ON property_unit_type_late_fees (property_id);
