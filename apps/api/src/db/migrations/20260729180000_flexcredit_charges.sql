-- S565: FlexCredit ($5/mo rent-credit-reporting subscription) monthly charge
-- ledger. Mirrors flex_deposit_custody_charges exactly (the $3/mo custody
-- analog). The monthly cron (services/flexCredit.ts processFlexCreditFee)
-- inserts one row per enrolled tenant per cycle, charges it via the platform
-- rail, and links the resulting payments row.
--
-- FULLY WIRED but INVISIBLE: enrollment is gated on flexcredit_rollout_visible
-- (OFF), so no tenant can enroll yet → the cron scans zero tenants and creates
-- zero charges until the flag flips. This exists so every money path (charge →
-- invoice/payment line item → GAM revenue → income pie) is in place the moment
-- the product launches. The provider (Esusu) payout side is a separate external
-- integration, not wired here. No backfill.

CREATE TABLE flexcredit_charges (
  id           uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  cycle_month  date NOT NULL,
  amount       numeric(10,2) NOT NULL,
  status       text NOT NULL DEFAULT 'pending',
  payment_id   uuid,
  created_at   timestamp with time zone NOT NULL DEFAULT NOW(),
  updated_at   timestamp with time zone NOT NULL DEFAULT NOW(),
  CONSTRAINT flexcredit_charges_cycle_tenant_uniq UNIQUE (cycle_month, tenant_id),
  CONSTRAINT flexcredit_charges_amount_positive CHECK (amount > 0),
  CONSTRAINT flexcredit_charges_status_check
    CHECK (status IN ('pending', 'settled', 'failed'))
);

CREATE INDEX idx_flexcredit_charges_tenant ON flexcredit_charges (tenant_id, cycle_month DESC);

COMMENT ON TABLE flexcredit_charges IS
  'S565 FlexCredit $5/mo subscription charge ledger (mirrors flex_deposit_custody_charges). Populated by the monthly cron for credit_reporting_enrolled tenants. Invisible until flexcredit_rollout_visible flips on.';
