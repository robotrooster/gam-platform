-- FlexSuite enrollment acceptance audit (S314)
--
-- Captures per-enrollment "I accepted these populated terms" records
-- for FlexPay subscription enrollment and FlexDeposit SLA enrollment.
-- Each row snapshots the full populated terms text the tenant saw at
-- click-through, hash-anchored for tamper evidence.
--
-- Why this is load-bearing:
--   FlexPay (subscription) and FlexDeposit (SLA-not-loan) both rest on
--   the consumer having received personalized terms and affirmatively
--   accepted them. At recharacterization challenge (CFPB / BNPL-style),
--   the structural defense is "here's exactly what they saw, here's
--   when they clicked Accept, here's the IP they did it from."
--   users.accepted_tos_at handles the global ToS gate; this table
--   handles the per-product, per-enrollment populated-terms gate.
--
-- Schema choices:
--   - rendered_text: full populated terms snapshot. Not derived at read
--     time from a template + params — stored verbatim so the row stays
--     reproducible even if the template file is rev'd in source. ~2-5 KB
--     per row; negligible storage cost for an audit table.
--   - content_hash: sha256 of rendered_text. Tamper-evidence on the
--     snapshot itself.
--   - template_version: lets us know which render fn produced this row.
--     New versions ship new exported render fns + bump this string.
--   - populated_content jsonb: the per-tenant variables (pull day, fee,
--     installment schedule, etc.) — redundant with rendered_text but
--     queryable for stats / debugging.
--
-- No backfill — pre-S314 enrollments simply have no row.
-- FlexDeposit enrollments since S260 captured the checkbox but didn't
-- persist anything; those rows stay un-audited (acceptable pre-launch
-- given dev-only seed data).

CREATE TABLE flexsuite_enrollment_acceptances (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id              uuid NOT NULL REFERENCES users(id),
  product_type         text NOT NULL,
  template_version     text NOT NULL,
  populated_content    jsonb NOT NULL,
  rendered_text        text NOT NULL,
  content_hash         text NOT NULL,
  accepted_at          timestamptz NOT NULL DEFAULT NOW(),
  accepted_ip          text,
  accepted_user_agent  text,
  created_at           timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT flexsuite_enrollment_acceptances_product_type_check
    CHECK (product_type IN ('flexpay', 'flexdeposit'))
);

CREATE INDEX idx_flexsuite_enrollment_acceptances_tenant
  ON flexsuite_enrollment_acceptances (tenant_id, product_type, accepted_at DESC);

COMMENT ON TABLE flexsuite_enrollment_acceptances IS
  'Audit record per FlexPay / FlexDeposit enrollment click-through. Stores the populated terms text the tenant saw at acceptance, hash-anchored. Structural defense for SLA-not-loan / subscription characterization.';
