-- Add 'FLEXPAY' to payments_entry_description_check.
--
-- WHY: services/flexpay.ts:processFlexPayPullDay stamps the tenant ACH
-- pull row with entry_description='FLEXPAY' (see the INSERT INTO payments
-- block — the cycle pull is rent + tenant fee combined, audit-marked
-- distinctly from regular RENT so reconcileSettledFlexPayPayment and
-- handleFlexPayPaymentNsf can filter on it). The S431 / initial CHECK
-- enumerated 'RENT', 'SUBSCRIP', 'DEPOSIT', 'UTILITY', 'ONTIMEPAY',
-- 'LATEFEE' but never added 'FLEXPAY' when the FlexPay subsystem
-- shipped, so every pull-day cron tick would have hit a CHECK
-- constraint violation at the INSERT step. Caught in S445 by the
-- flexpay.stripe.test.ts slice.
--
-- SAFE — NO BACKFILL NEEDED: zero payments rows exist with
-- entry_description='FLEXPAY' (the INSERT path could never have
-- succeeded under the prior CHECK).

ALTER TABLE public.payments
  DROP CONSTRAINT payments_entry_description_check;

ALTER TABLE public.payments
  ADD CONSTRAINT payments_entry_description_check
    CHECK (entry_description = ANY (ARRAY[
      'RENT'::text,
      'SUBSCRIP'::text,
      'DEPOSIT'::text,
      'UTILITY'::text,
      'ONTIMEPAY'::text,
      'LATEFEE'::text,
      'FLEXPAY'::text
    ]));
