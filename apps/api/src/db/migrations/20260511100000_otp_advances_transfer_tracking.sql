-- S244: track the Stripe Connect Transfer that funds an OTP advance.
--
-- Pre-S244, processMonthlyAdvance created the otp_advances row + a
-- shadow payments row and marked status='advanced', but no actual
-- money movement fired — cash sat on GAM's books and the landlord
-- never received the advance. S244 wires stripe.transfers.create
-- from the platform balance to the landlord's Connect account; these
-- columns capture the outcome.
--
-- stripe_transfer_id   — Stripe id of the successful transfer (tr_…)
-- transfer_attempted_at — most recent fire attempt timestamp; populated
--                          on both success and failure for ops
--                          visibility
-- transfer_error        — error message from the most recent failed
--                          attempt (null after a successful retry)
--
-- No backfill needed: existing 'advanced' rows from before S244 don't
-- have an associated Stripe Transfer (none fired pre-wiring). They
-- stay marked 'advanced' for historical accuracy; admins know money
-- never actually moved for them and can manually retry or write off.

ALTER TABLE otp_advances
  ADD COLUMN stripe_transfer_id    text,
  ADD COLUMN transfer_attempted_at timestamptz,
  ADD COLUMN transfer_error        text;

-- Partial index — only the rows with a transfer id need fast lookup.
-- Used by admin retry route to find the row by transfer id and by
-- future reconciliation tooling.
CREATE UNIQUE INDEX idx_otp_advances_stripe_transfer_id
  ON otp_advances (stripe_transfer_id)
  WHERE stripe_transfer_id IS NOT NULL;
