-- S583 (Nic) — FlexCharge merchant-set finance rate.
--
-- WHY: FlexCharge's structure keeps GAM a software vendor, not a lender. The
-- MERCHANT (Business Account Owner) is the one extending credit, so the MERCHANT
-- sets the finance charge their customers pay — GAM only takes a flat 1.5%
-- SUBSCRIPTION on the credit volume, deducted from the merchant's payout (never
-- charged to the borrower). Previously the code charged GAM's 1.5% to the
-- borrower and had NO merchant finance rate at all — both fixed in this change.
--
-- One posted rate PER PROPERTY (Location) — not per customer account — so every
-- customer at a store sees the same rate (fair-lending). Capped platform-wide at
-- 6%/month (FLEX_CHARGE_MAX_FINANCE_PCT in @gam/shared); a flat % of each monthly
-- statement balance, NOT APR/APY. Merchants must set a rate compliant with their
-- local usury / retail-installment law (no state-specific logic in the platform).

-- Per-property merchant finance rate. Default 0 = no finance charge (customer
-- pays only their purchase balance). No backfill needed (new column, default 0).
ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS flex_charge_finance_pct NUMERIC(5,4) NOT NULL DEFAULT 0
    CHECK (flex_charge_finance_pct >= 0 AND flex_charge_finance_pct <= 0.06);

-- Per-statement finance charge (balance * property rate at cut time), stored so
-- the customer statement itemizes purchases vs finance charge and the merchant
-- payout is auditable. No backfill needed (new column, default 0; existing rows
-- predate the feature and correctly show 0).
ALTER TABLE flex_charge_statements
  ADD COLUMN IF NOT EXISTS finance_charge NUMERIC(12,2) NOT NULL DEFAULT 0;
