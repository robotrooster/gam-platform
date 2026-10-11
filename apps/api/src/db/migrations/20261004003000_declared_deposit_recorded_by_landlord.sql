-- 10/3 (decisions #11; money plan Step 9 leftovers): a tenant's bank-deposit
-- report the LANDLORD then records by hand resolves as "recorded by your
-- landlord" — it never stays pending forever, and never becomes a strike.
--
-- Country Acres has no bank linked to GAM. A tenant there reports "I paid $X at
-- the bank"; GAM cannot watch for it, so the report waits (it is never written
-- off as "not found" without a bank to look in — jobs/declaredDepositExpiry).
-- The landlord looks at their own bank and records the payment at the desk.
-- Until now nothing connected the two: the report sat pending forever, and at a
-- company that did have a bank linked, a deposit the landlord recorded by hand
-- instead of matching it in the bank feed expired as "not found" — a strike
-- against the tenant for a payment the landlord had already taken.
--
-- jobs/declaredDepositExpiry now resolves a pending report when the landlord
-- has recorded a cash, check or money-order payment from that household
-- (a settled tenant_remittances row: the desk, a posted payment, a matched bank
-- deposit) dated on or after the reported day, for at least the reported
-- amount. The report becomes 'recorded' and names the receipt that covered it;
-- one receipt covers one report.
--
-- Expand-only: adds a status the old code never writes and a nullable column it
-- never reads. No backfill needed (no production report is in this state yet;
-- the sweep resolves any that are on its next run).

ALTER TABLE tenant_declared_deposits
  ADD COLUMN IF NOT EXISTS recorded_remittance_id uuid REFERENCES tenant_remittances(id) ON DELETE RESTRICT;

ALTER TABLE tenant_declared_deposits DROP CONSTRAINT IF EXISTS tenant_declared_deposits_status_check;
ALTER TABLE tenant_declared_deposits ADD CONSTRAINT tenant_declared_deposits_status_check
  CHECK (status IN ('pending', 'confirmed', 'unconfirmed', 'withdrawn', 'recorded'));

ALTER TABLE tenant_declared_deposits ADD CONSTRAINT tenant_declared_deposits_recorded_has_receipt
  CHECK ((status = 'recorded') = (recorded_remittance_id IS NOT NULL));

CREATE UNIQUE INDEX IF NOT EXISTS ux_tenant_declared_deposits_recorded_remittance
  ON tenant_declared_deposits (recorded_remittance_id) WHERE recorded_remittance_id IS NOT NULL;

COMMENT ON COLUMN tenant_declared_deposits.recorded_remittance_id IS
  'S655 (decisions #11): status recorded — the landlord''s own receipt (cash, check or money order, dated on or after the reported day, for at least the reported amount) that covered this report. One receipt covers one report.';
