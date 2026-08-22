-- S616: a bank descriptor for a charge that is not rent, a subscription, or a
-- deposit.
--
-- payments.entry_description is the NACHA-shaped category that reaches the
-- tenant's bank statement. One-off charges (a parking violation, damage, a
-- replacement key) had no honest value in the list: 'SUBSCRIP' is what monthly
-- lease fees use and would describe a fire-lane fine as a subscription on the
-- tenant's statement. Additive — no existing row violates the wider list.
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_entry_description_check;
ALTER TABLE payments ADD CONSTRAINT payments_entry_description_check
  CHECK (entry_description = ANY (ARRAY[
    'RENT','SUBSCRIP','DEPOSIT','UTILITY','ONTIMEPAY','LATEFEE','FLEXPAY',
    'PROPANE','RETURNFEE','MANUALPAY','HOMEPMT','FCPAYDOWN','DECLINEFEE',
    'BALANCE','OTHERFEE'
  ]));
