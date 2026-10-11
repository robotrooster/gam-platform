-- S652 (Nic): "I've got somebody that already wrote a check and paid ahead of
-- time for October ... there's only a way to add a charge. There's no way to
-- post a payment."
--
-- Money paid ahead already has a home (lease_prepaid_credits, applied to the
-- next invoice before it goes out) and a receipt record (tenant_remittances),
-- but a receipt could only be ACH or card. A check handed over at the office
-- is a receipt too: it needs its method, its check number, and who took it.
--
-- BACKFILL: none.
ALTER TABLE tenant_remittances DROP CONSTRAINT IF EXISTS tenant_remittances_payment_method_check;
ALTER TABLE tenant_remittances ADD CONSTRAINT tenant_remittances_payment_method_check
  CHECK (payment_method = ANY (ARRAY['ach','card','cash','check','money_order']));
ALTER TABLE tenant_remittances
  ADD COLUMN IF NOT EXISTS reference text,
  ADD COLUMN IF NOT EXISTS notes text,
  ADD COLUMN IF NOT EXISTS received_by uuid REFERENCES users(id);
COMMENT ON COLUMN tenant_remittances.reference IS 'S652: the check or money-order number, as handed over.';
COMMENT ON COLUMN tenant_remittances.received_by IS 'S652: who at the office posted this manual receipt.';
