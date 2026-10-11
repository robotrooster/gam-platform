-- S652 — A SHORTFALL THAT CARRIES FORWARD WITH NO DEADLINE.
--
-- Nic (for Blu and Curtis): "if there's a shortage, carry it forward because he
-- knows stuff is going to be coming up at some point. He's willing to float
-- that for an indefinite time."
--
-- carry_forward_months (S624) is how many month-closes a shortfall survives
-- before it is billed in cash. This switch says: never, while the agreement
-- runs. Ending the agreement still settles what is owed, as always.
-- A boolean rather than a NULL or a huge number, so no reader of
-- carry_forward_months can mistake "forever" for zero.
-- No backfill; Curtis Clabough is switched on at Nic's direction.
ALTER TABLE work_trade_agreements ADD COLUMN IF NOT EXISTS carry_forward_indefinite boolean NOT NULL DEFAULT false;
UPDATE work_trade_agreements SET carry_forward_indefinite = true
 WHERE id = '9f96f897-a4d5-40f8-b3f1-bc4f30ff79fe';
