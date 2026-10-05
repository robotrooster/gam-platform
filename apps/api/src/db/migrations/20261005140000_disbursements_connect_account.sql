-- 10/5 (Nic): "It's not per property. It's not per company. It's per connect
-- account... A login sits outside of the portfolio. It is a window to view
-- things." The payout run's spacing rule ("this account was paid N days ago")
-- read disbursements by the LOGIN (user_id), so paying one of a login's
-- companies made the run skip the login's other companies for days. Each
-- payout row now names the Stripe account it was paid from, and the rule reads
-- that.
--
-- Expand + backfill (from the webhook-fed connect_payouts by payout id). Safe
-- drop: the column and index; nothing else reads them.
ALTER TABLE public.disbursements ADD COLUMN IF NOT EXISTS stripe_account_id text;

UPDATE public.disbursements d
   SET stripe_account_id = cp.stripe_account_id
  FROM public.connect_payouts cp
 WHERE cp.stripe_payout_id = d.stripe_payout_id
   AND d.stripe_account_id IS NULL;

CREATE INDEX IF NOT EXISTS disbursements_account_created
  ON public.disbursements (stripe_account_id, created_at) WHERE stripe_account_id IS NOT NULL;
