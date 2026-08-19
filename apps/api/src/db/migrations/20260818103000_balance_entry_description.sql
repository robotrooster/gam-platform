-- S605: 'BALANCE' NACHA entry description for carried balances.
--
-- Fix-forward on 20260818100000_carried_tenant_balance.sql, which added the
-- carried-balance payment type but not the entry description that rides with
-- it, so the INSERT tripped payments_entry_description_check. (Written as its
-- own migration rather than edited into that one — the runner checksums applied
-- files and a mismatch blocks API startup.)
--
-- Its own descriptor rather than reusing 'RENT': entry_description is what the
-- tenant sees on their bank statement, and arrears from a previous manager
-- shown as a rent charge read like a duplicate rent debit — the fastest way to
-- turn a migration into a support call and a chargeback.
--
-- No backfill: no row carries this value yet.

ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_entry_description_check;
ALTER TABLE payments ADD CONSTRAINT payments_entry_description_check
  CHECK (entry_description = ANY (ARRAY[
    'RENT','SUBSCRIP','DEPOSIT','UTILITY','ONTIMEPAY','LATEFEE','FLEXPAY',
    'PROPANE','RETURNFEE','MANUALPAY','HOMEPMT','FCPAYDOWN','DECLINEFEE',
    'BALANCE'
  ]));
