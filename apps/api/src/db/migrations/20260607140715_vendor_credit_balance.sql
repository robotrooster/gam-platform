-- S413 (S386 Nic-locked decision): add credit_balance column to
-- books_vendors so the bill-pay route can accrue overpayment excess
-- against the vendor instead of silently absorbing it.
--
-- Pre-fix, POST /api/books/bills/:id/pay accepted any amount and:
--   - Stored amount_paid > amount on the bill (no constraint)
--   - Updated vendor ytd_paid by the full payAmount
--   - Updated vendor ap_balance via GREATEST(0, ap_balance - payAmount)
--     which clamps the negative to 0 — the excess just disappears
--     from the vendor accounting picture.
--
-- Post-fix behavior (in route):
--   - If req.body.acceptOverpayment !== true and payAmount exceeds the
--     bill remaining, return 409 with { requiresOverpaymentConfirm,
--     billRemaining, overpaymentAmount } so the frontend can show a
--     confirmation modal.
--   - On confirmation (acceptOverpayment=true), the bill closes at
--     amount_paid = amount, and the excess accrues to
--     books_vendors.credit_balance for application to future bills.
--
-- Credit APPLICATION (consumption on subsequent bills) is a separate
-- flow — out of S413 scope. The column is the storage substrate;
-- future session wires the spend.
--
-- No backfill needed: pre-S413 vendors have NULL credit_balance
-- which is treated as 0 by the route.

ALTER TABLE books_vendors
  ADD COLUMN credit_balance numeric(12, 2) DEFAULT 0;

COMMENT ON COLUMN books_vendors.credit_balance IS
  'S413/S386: accumulated credit from overpayments. Future bill-pay flows can consume this before charging the landlord.';
