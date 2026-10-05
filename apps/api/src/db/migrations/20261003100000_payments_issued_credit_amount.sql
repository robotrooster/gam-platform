-- S655 money plan M1 (Step 1). Expand-only: an added column with a default and
-- a non-negative check. Safe for the code running today, which never reads it.
--
-- WHY. A landlord-issued credit (a move-in special, goodwill, a refunded late
-- fee, an overcharge correction, the screening cap) pays part of a bill with
-- no money moving. That part is never the landlord's income and never part of
-- a payout. Kim Harland's September rent: $935.45 of bills, $450 of them paid
-- by the move-in special, so Oak Park received $485.45, not $935.45.
--
-- One per-row figure carries it, so the credit prompt, both report bases and
-- the payout read the same number. Only trg_credit_uses_apply writes it (M4):
-- the sum of the row's APPLIED uses of landlord-issued credit.
--
-- Not included: deposit interest (GAM funds it from escrow interest, so it is
-- new money to the landlord the day it pays a bill) and paid-ahead money (the
-- tenant's own money; it counts on the day it arrived).
--
-- There is no "<= amount" check: reverseLateFees zeroes a late fee's amount and
-- the history of what credit was spent on it must survive that.
ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS issued_credit_amount numeric(10,2) NOT NULL DEFAULT 0;
ALTER TABLE payments
  ADD CONSTRAINT payments_issued_credit_amount_nonneg CHECK (issued_credit_amount >= 0);
COMMENT ON COLUMN payments.issued_credit_amount IS
  'S655: dollars of this charge paid by a credit the LANDLORD issued (move-in special, goodwill, refunded fee, overcharge). No money moved for this part: never landlord income, never part of a payout. Deposit-interest credits are GAM-funded and are NOT included; paid-ahead money is NOT included (it is the tenant''s own money and counts on the day it arrived). Maintained only by trg_credit_uses_apply as the sum of the row''s applied landlord-issued uses.';
