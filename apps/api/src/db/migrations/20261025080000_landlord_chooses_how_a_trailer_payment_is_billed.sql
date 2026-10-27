-- 10/25 (Nic): "Leave current properties set up as is. Let landlords choose how
-- it gets bundled."
--
-- The trailer payment getting its own bill was built as a platform-wide rule.
-- It is a landlord's choice: some will want the installment on the rent bill
-- (one document, one payment), others will want it separate (paid on its own,
-- its own books). We provide the tools to do the job, whatever their job is.
--
-- Per PROPERTY, beside the other billing settings (billing cycle mode, grace
-- days), and DEFAULT SEPARATE — Nic's choice for Mountain View and Oak Park.
--
-- Separate always wins when there is nothing to bundle into: a buyer on work
-- trade gets no rent bill (Lisa Scheeler), and a buyer who rents no space at
-- that park has no rent bill either (the operator with a hundred homes across
-- parks he does not own). Those are billed on the contract's own bill whatever
-- this says, because the alternative is not billing them at all.
--
-- No backfill, and nothing already billed moves: the five October bills that
-- went out with a trailer payment on them stay exactly as those residents
-- received them ("leave current properties set up as is").

ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS home_payments_own_bill BOOLEAN NOT NULL DEFAULT TRUE;

COMMENT ON COLUMN properties.home_payments_own_bill IS
  'TRUE (default): an installment (home/trailer) payment is billed on the
   contract''s own bill, paid separately from the space rent. FALSE: it rides
   the buyer''s rent bill for that month, when there is one. A buyer with no
   rent bill for the month is billed on their own bill either way.';
