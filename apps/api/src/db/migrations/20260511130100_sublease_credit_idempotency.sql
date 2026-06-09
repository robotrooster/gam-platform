-- S247: idempotency marker for sublessor markup credit.
--
-- creditSublessorMarkupForPayment runs on every settled rent payment
-- via the webhook. Without a per-payment marker the same payment
-- could double-credit on webhook re-delivery. This column is the
-- marker — set to TRUE inside the same transaction that bumps the
-- sublessor_credit_balances row.

ALTER TABLE payments
  ADD COLUMN sublease_credit_applied boolean NOT NULL DEFAULT false;
