-- S565: FlexCredit (rent-payment credit reporting) DEMAND-CAPTURE inquiry.
--
-- FlexCredit is a soon-to-launch product (Esusu white-label rent reporting;
-- sell ~$5/mo, ~$1.50 to the provider → ~$3.50 GAM net, but the provider has a
-- ~$500/mo minimum, so it can only launch once adoption clears breakeven). Per
-- the same demand-test philosophy as FlexPay, we capture INTEREST first —
-- separate from FlexPay (which is income-verification gated); FlexCredit needs
-- no income verification. Nothing here bills or enrolls with Esusu — that's the
-- later launch phase, gated on flexcredit_rollout_visible + breakeven.
--
-- One row per tenant (a tenant either wants it or doesn't). Status is
-- 'interested' for now; 'enrolled'/'declined' reserved for the launch phase.
-- No backfill.

CREATE TABLE flexcredit_inquiries (
  id          uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  status      text NOT NULL DEFAULT 'interested',
  note        text,
  created_at  timestamp with time zone NOT NULL DEFAULT NOW(),
  updated_at  timestamp with time zone NOT NULL DEFAULT NOW(),
  CONSTRAINT flexcredit_inquiries_tenant_uniq UNIQUE (tenant_id),
  CONSTRAINT flexcredit_inquiries_status_check
    CHECK (status IN ('interested', 'enrolled', 'declined'))
);

COMMENT ON TABLE flexcredit_inquiries IS
  'S565 FlexCredit demand-capture: one interest row per tenant. Demand-test only — no billing/Esusu enrollment wired. Mirrors flexpay_inquiries but with no income verification (credit reporting needs none).';
