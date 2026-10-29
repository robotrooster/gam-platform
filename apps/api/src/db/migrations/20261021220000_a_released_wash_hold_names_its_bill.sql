-- 10/20 — A RELEASED WASH HOLD NAMES THE BILL IT BECAME.
--
-- Nic, on people who leave early: "we also don't bill them a final electric
-- bill ... I would like to keep track of money that wasn't refunded versus
-- electric that should have been billed that wasn't charged."
--
-- A departing payer's final stub is PARKED (utility_wash_holds, added by
-- 20261021210000) when the closing read lands before the money question is
-- answered, because billing it and then learning it was a wash means reversing
-- a charge the guest may already have read in an email. Two answers can come
-- back. "No refund" absorbs the stub onto the book, and the hold already names
-- the line it became (absorbed_charge_id). "A refund went out" means it bills
-- as usual — and the hold had nowhere to write WHICH bill, because releasing a
-- hold and billing it were two separate jobs with nobody holding both. So a
-- released hold named no bill and no bill existed: the power was neither
-- charged to the guest who was refunded nor recorded as absorbed, and the only
-- thing that ever recovered it was a billing run happening to look at that
-- meter and cycle again.
--
-- This is the other half of the pair, and the same column the invite hold this
-- table is shaped after has carried since S629:
-- suspended_utility_charges.released_bill_id, stamped in the same breath as the
-- INSERT that creates the bill.
--
-- Expand-only and re-runnable. No backfill needed: utility_wash_holds is new in
-- 20261021210000 and holds no rows on production.

ALTER TABLE utility_wash_holds
  ADD COLUMN IF NOT EXISTS released_bill_id uuid REFERENCES utility_bills(id) ON DELETE SET NULL;

-- Answers "which hold did this bill come out of", which is the question an
-- audit of a departure asks from the bill's end.
CREATE INDEX IF NOT EXISTS idx_utility_wash_hold_released_bill
  ON utility_wash_holds (released_bill_id)
  WHERE released_bill_id IS NOT NULL;

COMMENT ON COLUMN utility_wash_holds.released_bill_id IS
  'The utility_bills row this parked stub was billed onto when its hold was released — a refund went out, or the check-out was undone, so it is owed after all. Null while the hold is still waiting, null on a hold the billing run itself billed in the same breath as releasing it (its own numbers are fresher than the parked copy''s), and null when nobody is set up to be billed for utilities on that space, in which case released_reason says so. Mirrors suspended_utility_charges.released_bill_id.';
