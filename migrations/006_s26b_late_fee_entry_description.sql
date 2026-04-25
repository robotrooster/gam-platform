-- migrations/006_s26b_late_fee_entry_description.sql
-- S26b: Add 'LATEFEE' to payments.entry_description CHECK so the late fee
-- engine can insert with semantically-correct ACH entry description.

BEGIN;

ALTER TABLE payments DROP CONSTRAINT payments_entry_description_check;

ALTER TABLE payments ADD CONSTRAINT payments_entry_description_check
  CHECK (entry_description = ANY (ARRAY[
    'RENT'::text,
    'SUBSCRIP'::text,
    'DEPOSIT'::text,
    'UTILITY'::text,
    'ONTIMEPAY'::text,
    'LATEFEE'::text
  ]));

COMMIT;
