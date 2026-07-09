-- Utility tax configuration (Nic, S533).
--
-- Landlords must collect tax on utility resale / propane sales in many
-- jurisdictions and the rate differs by utility (propane sales tax vs
-- utility resale tax). Per the no-state-specific-logic rule these are
-- LANDLORD-ENTERED rates — per property, per utility type ('propane'
-- rides this table too even though it isn't a metered utility). Tax is
-- SNAPSHOTTED onto each bill/fill at billing time (rate changes never
-- rewrite history — same posture as rate_per_unit snapshots, S90) and
-- shows as a separate amount alongside the charge.
--
-- No backfill needed: absent row or 0 rate = no tax; existing bills
-- get tax_amount 0 via the column DEFAULT.

CREATE TABLE property_utility_tax_rates (
    id           uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    property_id  uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    utility_type text NOT NULL CHECK (utility_type IN ('water','gas','electric','sewer','trash','propane')),
    tax_rate_pct numeric(6,4) NOT NULL CHECK (tax_rate_pct >= 0 AND tax_rate_pct <= 100),
    label        text,   -- landlord's own name for it, e.g. "AZ TPT"
    updated_at   timestamptz NOT NULL DEFAULT now(),
    UNIQUE (property_id, utility_type)
);

ALTER TABLE utility_bills
    ADD COLUMN tax_rate_pct numeric(6,4) NOT NULL DEFAULT 0,
    ADD COLUMN tax_amount   numeric(10,2) NOT NULL DEFAULT 0;

ALTER TABLE propane_fills
    ADD COLUMN tax_rate_pct numeric(6,4) NOT NULL DEFAULT 0,
    ADD COLUMN tax_amount   numeric(10,2) NOT NULL DEFAULT 0;
