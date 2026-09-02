-- S634 (Nic, DIRECTIVE): "Have the work trade exist, but be suspended... and it
-- creates only at the month close."
--
-- "Nobody is gonna pay rent that month and then work hours for the following
-- month. There's no arrears arrangement here. They work, and at the end of the
-- month, if they don't hit their hours, the rent for that month is prorated to
-- cover any lapse."
--
-- The month-close arithmetic already worked this way (services/workTradeSettlement
-- .ts, built on Nic's own worked examples): hours settle their own month, a
-- covered month goes to zero, a short month keeps the lapse. What did NOT work
-- was the month IN PROGRESS — the rent line was written `pending` on day one and
-- counted as an outstanding balance while the tenant was working it off. That is
-- the arrears shape the agreement does not have, and it is what put $14.19
-- against RV 03 on the landlord's dashboard during the month they were working.
--
-- A suspended line EXISTS — the month's worth is what the hours are priced
-- against (work_trade_settlements.basis_amount) and the tenant should see what
-- the month was worth — but it is not money owed, so it stays out of
-- invoices.total_amount and therefore out of every outstanding-balance surface.
-- Month close clears the flag and leaves either 0 or the lapse.
--
-- Nullable timestamp rather than a new `status`: every consumer of
-- payments.status keeps its existing meanings, and "when was this suspended"
-- is worth more than a boolean when explaining a bill to a resident.
ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS work_trade_suspended_at timestamptz;

COMMENT ON COLUMN payments.work_trade_suspended_at IS
  'S634: set while a work-trade agreement covers this charge for a month still being worked. A suspended row is NOT owed — it is excluded from invoices.total_amount and from outstanding balances. Month-close settlement clears it, leaving 0 (hours met) or the prorated lapse.';

CREATE INDEX IF NOT EXISTS payments_work_trade_suspended_idx
  ON payments (invoice_id) WHERE work_trade_suspended_at IS NOT NULL;
