-- POS direct-sale discount capture (S554, launch button sweep bug #2).
--
-- WHY: apps/pos POSPage applies a cart discount, mints the terminal
-- PaymentIntent at the DISCOUNTED total, and POSTs discountAmount/
-- discountReason to /pos/transactions. The route dropped both fields and
-- recomputed an UNDISCOUNTED total, so the server total exceeded the
-- captured PI amount and the S242 amount-match guard 400'd AFTER the card
-- was already captured (money taken, no sale). The cash path recorded the
-- undiscounted total, overstating the books.
--
-- The session-based checkout path already tracks discount on
-- pos_sessions.discount_amount; the direct /transactions path had nowhere
-- to store it. These columns give the direct path proper books: subtotal
-- stays GROSS, discount_amount is the reduction, total is NET
-- (gross - discount + tax + surcharge).
--
-- No backfill needed: existing rows had no discount (default 0 / NULL).

ALTER TABLE pos_transactions
  ADD COLUMN IF NOT EXISTS discount_amount numeric(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS discount_reason text;
