-- S583 (Nic) — allow 'FCPAYDOWN' as a payments.entry_description.
--
-- A FlexCharge revolving pay-down (customer paying more than the auto-pulled
-- minimum) records a type='fee' payments row tagged 'FCPAYDOWN'. Mirrors the
-- shared PAYMENT_ENTRY_DESCRIPTIONS array. Fix-forward: drop + re-add the CHECK.
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_entry_description_check;
ALTER TABLE payments ADD CONSTRAINT payments_entry_description_check
  CHECK (entry_description IN ('RENT','SUBSCRIP','DEPOSIT','UTILITY','ONTIMEPAY','LATEFEE','FLEXPAY','PROPANE','RETURNFEE','MANUALPAY','HOMEPMT','FCPAYDOWN'));
