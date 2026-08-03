-- Allow the 'HOMEPMT' entry description on payments (S568, Nic).
--
-- WHY: financed home-sale installments bill as type='home_payment' rows carrying
-- the NACHA-shaped entry_description 'HOMEPMT' (single source: shared
-- PAYMENT_ENTRY_DESCRIPTIONS). The CHECK constraint must list it too, or the
-- billing INSERT fails. Widening an allowed-value CHECK — safe, no backfill.

ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_entry_description_check;
ALTER TABLE payments ADD CONSTRAINT payments_entry_description_check
  CHECK (entry_description IN ('RENT','SUBSCRIP','DEPOSIT','UTILITY','ONTIMEPAY','LATEFEE','FLEXPAY','PROPANE','RETURNFEE','MANUALPAY','HOMEPMT'));
