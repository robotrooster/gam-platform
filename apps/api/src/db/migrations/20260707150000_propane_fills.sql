-- Propane tank-fill billing (Nic, S533).
--
-- RV gas is propane tank fills, not metered usage — natural gas on
-- single-family homes is direct-billed to the tenant by the utility, so
-- GAM does no gas billback (a metered-gas billback waits for a real use
-- case). A fill bills gallons × a PER-FILL price (PPG fluctuates and is
-- deliberately independent of POS propane pricing — big tanks can get a
-- better rate).
--
-- Split payments: 2 or 4 only (shared propaneSplitOptions: <25 gal
-- ineligible, 4-way reserved for 100+ gal). Installment #1 bills
-- IMMEDIATELY as a standalone payments row (type='utility',
-- entry_description='PROPANE'); the rest ride consecutive monthly
-- invoices via invoiceGeneration. PROPANE rows are exempt from late
-- fees (lateFees.ts skips invoices whose only unpaid children are
-- PROPANE). Unpaid balances still sweep from the deposit at lease end
-- via the S180 unpaid-payments sweep (type='utility' rows qualify).
--
-- Installment progress is DERIVED: payment_id IS NULL = not yet billed;
-- otherwise the linked payments row's status is the truth. No status
-- columns to drift.
--
-- Property toggles (per-property flexibility per the platform
-- simplicity rule): landlords opt in to splits, and may block the next
-- fill until the previous fill's payments complete.
--
-- No backfill needed: brand-new feature, toggles default off.

ALTER TABLE properties
    ADD COLUMN propane_allow_installments boolean NOT NULL DEFAULT false,
    ADD COLUMN propane_block_refill_until_paid boolean NOT NULL DEFAULT false;

CREATE TABLE propane_fills (
    id                 uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    property_id        uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    landlord_id        uuid NOT NULL REFERENCES landlords(id) ON DELETE CASCADE,
    unit_id            uuid NOT NULL REFERENCES units(id) ON DELETE CASCADE,
    lease_id           uuid NOT NULL REFERENCES leases(id),
    tenant_id          uuid NOT NULL REFERENCES tenants(id),
    fill_date          date NOT NULL DEFAULT CURRENT_DATE,
    gallons            numeric(8,2) NOT NULL CHECK (gallons > 0),
    price_per_gallon   numeric(8,4) NOT NULL CHECK (price_per_gallon >= 0),
    total_amount       numeric(10,2) NOT NULL,
    installment_count  integer NOT NULL CHECK (installment_count IN (1, 2, 4)),
    created_by_user_id uuid REFERENCES users(id),
    created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_propane_fills_property ON propane_fills (property_id, fill_date DESC);
CREATE INDEX idx_propane_fills_unit ON propane_fills (unit_id);

CREATE TABLE propane_fill_installments (
    id                  uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    fill_id             uuid NOT NULL REFERENCES propane_fills(id) ON DELETE CASCADE,
    installment_number  integer NOT NULL,
    amount              numeric(10,2) NOT NULL,
    billing_cycle_month date NOT NULL,   -- which monthly invoice carries it (#1 = fill month, billed immediately)
    payment_id          uuid REFERENCES payments(id),
    created_at          timestamptz NOT NULL DEFAULT now(),
    UNIQUE (fill_id, installment_number)
);

CREATE INDEX idx_propane_installments_unbilled
    ON propane_fill_installments (billing_cycle_month)
    WHERE payment_id IS NULL;
