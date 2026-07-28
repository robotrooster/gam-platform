-- S562: manual (cash / check / money-order) rent-payment recording + the $10
-- manual-payment fee (first rent payment waived).
--
-- WHY: tenants who haven't onboarded ACH may pay rent off-platform by cash,
-- check, or money order. A landlord/staff records receipt; the rent obligation
-- is satisfied WITHOUT GAM moving money (the landlord already physically holds
-- the cash). We mark such a rent row status='settled' with platform_held=false
-- and stripe_payment_intent_id=NULL — "paid" everywhere that already treats
-- settled as paid (balance / FIFO / late-fee / rent-roll), while the weekly
-- batch (services/landlordPassthrough.ts) skips it because that path requires
-- platform_held=true. No new status → no status-consumer sweep.
--
-- Two schema changes:
--   1. `manual_method` — records HOW it was paid (cash/check/money_order), and
--      is the unambiguous marker of a manual settled row (vs a Stripe one).
--   2. entry_description 'MANUALPAY' — the tenant-owed $10 fee row (type='fee',
--      GAM revenue, same shape as RETURNFEE). Waived on the lease's FIRST rent
--      payment to give the tenant time to onboard ACH.
--
-- No backfill needed (new nullable column; new enum value only used going
-- forward). Mirrors packages/shared PAYMENT_ENTRY_DESCRIPTIONS (which this
-- migration also brings back in sync by adding the historically-omitted
-- 'FLEXPAY' there — the DB CHECK already carried it).

ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS manual_method text;

ALTER TABLE public.payments
  DROP CONSTRAINT IF EXISTS payments_manual_method_check;

ALTER TABLE public.payments
  ADD CONSTRAINT payments_manual_method_check
  CHECK (manual_method IS NULL OR manual_method = ANY (ARRAY[
    'cash'::text, 'check'::text, 'money_order'::text
  ]));

ALTER TABLE public.payments
  DROP CONSTRAINT payments_entry_description_check;

ALTER TABLE public.payments
  ADD CONSTRAINT payments_entry_description_check
  CHECK (entry_description = ANY (ARRAY[
    'RENT'::text, 'SUBSCRIP'::text, 'DEPOSIT'::text, 'UTILITY'::text,
    'ONTIMEPAY'::text, 'LATEFEE'::text, 'FLEXPAY'::text, 'PROPANE'::text,
    'RETURNFEE'::text, 'MANUALPAY'::text
  ]));
