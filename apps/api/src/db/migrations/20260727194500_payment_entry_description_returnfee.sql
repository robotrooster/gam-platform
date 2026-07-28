-- S561 (money-flow platform-holds, Phase 3): allow 'RETURNFEE' as a payments
-- entry_description.
--
-- WHY: a post-settlement reversal bills the tenant the pass-through Stripe
-- reversal fee ($4 ACH / $15 card) at cost as an owed 'fee' payment row
-- (services/paymentReversal.ts). entry_description is a controlled NACHA-style
-- code (≤10 chars); none of the existing codes fit a return/reversal fee, so
-- add 'RETURNFEE' (9 chars). Mirrors packages/shared PAYMENT_ENTRY_DESCRIPTIONS.
--
-- Recreates the CHECK with the full existing set + the new value. No backfill
-- needed. (Note: the shared PAYMENT_ENTRY_DESCRIPTIONS array historically
-- omitted 'FLEXPAY' which this DB CHECK carries — pre-existing drift, left
-- as-is; this migration preserves 'FLEXPAY'.)

ALTER TABLE public.payments
  DROP CONSTRAINT payments_entry_description_check;

ALTER TABLE public.payments
  ADD CONSTRAINT payments_entry_description_check
  CHECK (entry_description = ANY (ARRAY[
    'RENT'::text, 'SUBSCRIP'::text, 'DEPOSIT'::text, 'UTILITY'::text,
    'ONTIMEPAY'::text, 'LATEFEE'::text, 'FLEXPAY'::text, 'PROPANE'::text,
    'RETURNFEE'::text
  ]));
