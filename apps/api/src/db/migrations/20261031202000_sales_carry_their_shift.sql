-- 10/31 (Nic) — A SALE HAS TO SAY WHICH DRAWER IT WENT INTO.
--
-- Nothing on a sale said which register rang it. pos_transactions carries the
-- cashier and the property and that is all, so "what should THIS drawer hold"
-- had no answer and a per-register count was impossible. Same on a refund:
-- cash handed back comes out of one particular drawer.
--
-- Stamped with the SHIFT rather than the register, deliberately. The shift
-- implies the register, and it removes the boundary question entirely: a sale
-- rung while a cashier is mid-count would otherwise land in whichever shift a
-- timestamp comparison happened to pick. The register app sends the shift it is
-- ringing into; the server trusts nothing and checks the shift is open, belongs
-- to the property, and is the caller's to ring into.
--
-- NULLABLE, and most rows will stay NULL forever:
--   - every sale before today (the 20 closed days at Mountain View);
--   - a property that never makes a register, which still gets its nightly day
--     settlement exactly as before;
--   - a pay-link paid online, which never touched a drawer at all.
-- So a register's count covers only what is stamped to it, and the property's
-- day settlement keeps covering everything. Neither number can quietly absorb
-- the other's sales — which is also why this is not backfilled with a guess.
--
-- ON DELETE RESTRICT on the shift: a closed shift's count is evidence of what
-- was in a drawer, and the sales behind it have to stay reachable.

ALTER TABLE pos_transactions
  ADD COLUMN IF NOT EXISTS register_shift_id uuid REFERENCES pos_register_shifts(id) ON DELETE RESTRICT;

ALTER TABLE pos_refunds
  ADD COLUMN IF NOT EXISTS register_shift_id uuid REFERENCES pos_register_shifts(id) ON DELETE RESTRICT;

-- The lookup both the live "what should this drawer hold" and the close do.
CREATE INDEX IF NOT EXISTS ix_pos_transactions_shift
  ON pos_transactions (register_shift_id) WHERE register_shift_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_pos_refunds_shift
  ON pos_refunds (register_shift_id) WHERE register_shift_id IS NOT NULL;

COMMENT ON COLUMN pos_transactions.register_shift_id IS
  '10/31: the shift this sale was rung into, which implies the register. NULL for every sale before registers existed, for a property with no registers, and for anything paid online — a drawer count covers only what is stamped to it, while the property day settlement still covers everything.';
COMMENT ON COLUMN pos_refunds.register_shift_id IS
  '10/31: the shift whose drawer this refund came out of. NULL when it was not cash out of a till.';
