-- 10/27 (Nic): "Yes, delete it if it's not being used."
--
-- `tenant_income_documents` was created on 10/27 for FlexPay's proof-of-income
-- step, and then not needed: `flexpay_inquiries.proof_file_path` already holds
-- the uploaded proof and already runs the automated verification against it.
-- Two places to put the same document is how they drift.
--
-- VERIFIED EMPTY AND UNREAD before dropping, on production:
--   * 0 rows.
--   * The only references anywhere in apps/ or packages/ are inside the
--     migration that created it — no route, service, job or test reads or
--     writes it.
-- So this erases no record of anything, which is the only reason it is a DROP
-- rather than a soft-delete (GAM keeps everything that was ever real).
--
-- DELIBERATELY NARROW. The same 10/27 migration also added
-- tenants.fixed_income_self_reported / _asked_at / _answered_at, which ARE in
-- use (the self-reported fixed-income banner — never the verified flag that
-- gates FlexDeposit). Those stay. Only the table goes.
--
-- The migration that created it is not edited; the runner is fix-forward and
-- an applied file's checksum is what lets it be trusted.

DROP INDEX IF EXISTS ux_tenant_income_documents_url;
DROP INDEX IF EXISTS idx_tenant_income_documents_tenant;
DROP TABLE IF EXISTS tenant_income_documents;
