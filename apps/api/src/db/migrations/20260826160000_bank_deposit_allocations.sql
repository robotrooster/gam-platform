-- S624 — which charges a bank deposit actually paid, all of them.
--
-- `bank_transactions.matched_payment_id` holds ONE payment. That was fine when
-- auto-matching only ever tied a deposit to a single GAM disbursement, but a
-- tenant deposit routinely settles more than one charge — rent plus last month's
-- manual-payment fee is the ordinary case — and an on-site office banking the
-- day's takings settles many at once. Recording only the first is lossy in the
-- worst way: the link looks present, so nothing ever flags it as missing.
--
-- THE ON-SITE CASE IS WHY THIS EARNS A TABLE (Nic, S624): "a landlord would mark
-- each one paid as they collect the rent in person in the office, and then the
-- bulk deposit would be sorted and verified against those ones that were marked
-- paid in person. It needs a double verification."
--
-- That is not just reconciliation, it is a CONTROL. Staff collect cash and mark
-- each tenant paid; the deposit later posts; GAM compares the deposit against
-- everything marked collected-but-not-yet-banked. If the office took in $3,000
-- and banked $2,750, that is a $250 gap WITH NAMES ATTACHED. For an owner
-- running a park through on-site staff that is a thing they have never had, and
-- it falls straight out of the same allocation rows.
--
-- matched_payment_id is left in place and still populated with the first charge:
-- the disbursement auto-match reads it, and quietly changing its meaning would
-- be worse than leaving a narrower field beside a complete one.

CREATE TABLE IF NOT EXISTS bank_deposit_allocations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bank_transaction_id uuid NOT NULL
    REFERENCES bank_transactions(id) ON DELETE RESTRICT,
  payment_id     uuid NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
  landlord_id    uuid NOT NULL REFERENCES landlords(id) ON DELETE RESTRICT,
  amount         numeric(12,2) NOT NULL,
  -- The date the rent was treated as paid — the tenant's declared date when the
  -- bank corroborated it, otherwise the bank's posting. Stored because it is the
  -- figure the late-fee reversal was computed from, and a later question about
  -- why a fee vanished has to be answerable without re-deriving it.
  effective_paid_date date NOT NULL,
  created_at     timestamp with time zone NOT NULL DEFAULT now(),

  CONSTRAINT bank_deposit_allocations_amount_positive CHECK (amount > 0)
);

-- One deposit cannot pay the same charge twice.
CREATE UNIQUE INDEX IF NOT EXISTS ux_bank_deposit_allocations_txn_payment
  ON bank_deposit_allocations (bank_transaction_id, payment_id);
-- And one charge cannot be paid by two different deposits.
CREATE UNIQUE INDEX IF NOT EXISTS ux_bank_deposit_allocations_payment
  ON bank_deposit_allocations (payment_id);
CREATE INDEX IF NOT EXISTS idx_bank_deposit_allocations_txn
  ON bank_deposit_allocations (bank_transaction_id);
CREATE INDEX IF NOT EXISTS idx_bank_deposit_allocations_landlord
  ON bank_deposit_allocations (landlord_id, created_at DESC);

COMMENT ON TABLE bank_deposit_allocations IS
  'S624: every charge a bank deposit settled. Also the basis for the on-site cash control — collected-but-not-banked is what has no allocation row.';
