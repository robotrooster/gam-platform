-- 10/31 (Nic) — A DEPOSIT SLIP CAN CARRY A DRAWER DROP.
--
-- Two stages, his words (10/30): staff count the drawer down to what it started
-- with, and the money pulled out waits "because it's not worth the gas to drive
-- $100 to the bank when another $100 might come tomorrow." So ONE bank deposit
-- is several days of drops.
--
-- The slip already bundles what goes in the bag: tenant receipts, register cash
-- sales, and "other money" GAM never recorded. What it could not hold was a
-- DROP — the cash that physically came out of a counted drawer.
--
-- ── WHY A DROP AND NOT THE SALES IT CAME FROM ───────────────────────────────
--
-- Before drawer counts existed, ticking the individual cash sales was the best
-- available guess at what was in the bag. It is not the same number. A drawer
-- that came up $20 short has $20 less in the bag than its sales say, and one
-- that came up over has more. The drop is what somebody physically carried out
-- of the till; the sales are what the register thinks happened. When a drawer
-- has been counted, the drop is the true figure and the sales behind it must NOT
-- also be offered, or the same money is banked twice (every dollar counted once).
--
-- services/depositSlips enforces exactly that: a cash sale stamped to a CLOSED
-- shift stops appearing on its own, because its money is inside that shift's
-- drop. A sale with no shift — a property that has never made a register, which
-- is every property today bar one — keeps listing individually, unchanged.
--
-- ONE LIVE SLIP PER DROP, mirroring ux_slip_items_remittance_live and
-- ux_slip_items_pos_live: a drop cannot be in two bags at once.
--
-- No backfill: no slips exist yet and no drawer has been counted in production.

ALTER TABLE bank_deposit_slip_items
  ADD COLUMN IF NOT EXISTS register_shift_id uuid REFERENCES pos_register_shifts(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS ux_slip_items_drawer_drop_live
  ON bank_deposit_slip_items (register_shift_id)
  WHERE register_shift_id IS NOT NULL AND voided_at IS NULL;

-- A line is exactly one thing: a receipt, a register sale, or a drawer drop.
-- Two of them on one row would be the same money under two names.
ALTER TABLE bank_deposit_slip_items DROP CONSTRAINT IF EXISTS bank_deposit_slip_items_one_source;
ALTER TABLE bank_deposit_slip_items
  ADD CONSTRAINT bank_deposit_slip_items_one_source CHECK (
    (remittance_id IS NOT NULL)::integer
    + (pos_transaction_id IS NOT NULL)::integer
    + (register_shift_id IS NOT NULL)::integer <= 1);

COMMENT ON COLUMN bank_deposit_slip_items.register_shift_id IS
  '10/31: this line is a counted drawer''s DROP — the cash physically taken out of the till when the shift was counted down. Truer than the sales behind it, because a short or over drawer sends a different amount to the bank than the register thinks. A sale inside a counted shift is not offered separately.';
