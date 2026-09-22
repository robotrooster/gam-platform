-- S652 — A PAYOUT SAYS WHERE IT WENT, AND PAYOUTS MADE IN STRIPE SHOW UP.
--
-- Nic, on the dashboard: "It doesn't show which bank it's going to. It doesn't
-- show which property it's for... Disbursements is just very generic." And the
-- $4,154.89 he paid out himself from the Stripe dashboard never appeared —
-- Stripe's connected-account payout events were never reaching GAM (zero rows
-- in connect_payouts, ever), so only GAM-initiated payouts had a row.
--
-- bank_name / bank_last4 — stamped on every row from Stripe's own payout
--   record (the destination account), so the row carries where the money went
--   even when no GAM bank record is linked.
-- 'stripe_dashboard' — a payout the landlord made in Stripe, pulled in by the
--   sync (services/connectPayoutSync.ts) so the portal's history is complete.
-- No backfill here; the sync backfills from Stripe on its first run.
ALTER TABLE disbursements
  ADD COLUMN IF NOT EXISTS bank_name text,
  ADD COLUMN IF NOT EXISTS bank_last4 text;
ALTER TABLE disbursements DROP CONSTRAINT IF EXISTS disbursements_trigger_type_check;
ALTER TABLE disbursements ADD CONSTRAINT disbursements_trigger_type_check
  CHECK (trigger_type IS NULL OR trigger_type IN ('auto_friday','manual_on_demand','otp_legacy','catch_up','stripe_dashboard'));
