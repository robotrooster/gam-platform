-- S542: platform-originated tenant questionnaires (Nic).
--
-- WHY: FlexPay's demand-test rollout needs to FIND the right tenants
-- (fixed-income SSI/SSDI) without involving the landlord. The platform
-- watches for indicators and auto-sends the tenant a short, private
-- questionnaire; a positive answer funnels into flexpay_inquiries
-- (the S541 review queue). LANDLORD-INVISIBLE BY DESIGN: no landlord
-- route may ever select from or join this table — tenant + admin
-- surfaces only. Answers are confidential product-fit data.
--
-- v1 triggers:
--   ssi_ssdi_signal        — tenants.ssi_ssdi already flagged (import/
--                            onboarding) but not enrolled + no inquiry;
--                            daily sweep.
--   late_fee_fixed_income  — a late_fee payment row was just generated;
--                            ask whether the fee traces to fixed-income
--                            timing and whether they want to fix that.
-- More indicators append to the CHECK via fix-forward migrations.
--
-- One row per (tenant, trigger): the questionnaire is a one-shot ask
-- per signal — re-asking after a dismissal is spam, and an answered
-- row already routed the tenant to the inquiry queue.
--
-- No backfill needed (new feature).

CREATE TABLE tenant_questionnaires (
  id           uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  trigger_type text NOT NULL
               CHECK (trigger_type IN ('ssi_ssdi_signal', 'late_fee_fixed_income')),
  status       text NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'answered', 'dismissed')),
  -- {incomeSource:'ssi'|'ssdi'|'other_fixed'|'none', interested:boolean}
  answers      jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  answered_at  timestamptz,
  UNIQUE (tenant_id, trigger_type)
);

CREATE INDEX ix_tenant_questionnaires_pending
  ON tenant_questionnaires(tenant_id) WHERE status = 'pending';
