-- 10/12 (Nic, G1) — WHAT A FAILED BANK PULL OF GAM'S FEES ACTUALLY COST.
--
-- "gam eats no fees of failed pulls ever." When a pull fails — refused on the
-- spot or returned by the bank later — GAM reads from Stripe what Stripe
-- charged for it (the debit's own fee and the failure fee: the charge's
-- balance transaction and its failure balance transaction) and charges the
-- landlord exactly that, as a 'bank_debit_failed_cost' GAM charge
-- (services/landlordGamDebit).
--
--   failure_cost_amount     — what the failed pull cost GAM, in dollars, once
--                             read (0 when Stripe charged nothing — a pull it
--                             refused before making it). NULL: not read yet;
--                             the nightly sweep asks Stripe again.
--   failure_cost_charge_id  — the GAM charge that bills it (NULL when it cost
--                             nothing).
--   failure_cost_read_at    — when it was read.
--
-- Expand-only, nullable columns; nothing reads them before the code ships.
-- No backfill: a failed pull before this was never charged its cost, and its
-- cost is not on record here (Stripe still has it — the sweep only reads
-- pulls that failed in its own window, see the code).

ALTER TABLE landlord_gam_debits
  ADD COLUMN IF NOT EXISTS failure_cost_amount    numeric(12,2),
  ADD COLUMN IF NOT EXISTS failure_cost_charge_id uuid REFERENCES landlord_gam_charges(id),
  ADD COLUMN IF NOT EXISTS failure_cost_read_at   timestamptz;

ALTER TABLE landlord_gam_debits DROP CONSTRAINT IF EXISTS landlord_gam_debits_failure_cost_check;
ALTER TABLE landlord_gam_debits ADD CONSTRAINT landlord_gam_debits_failure_cost_check
  CHECK ((failure_cost_amount IS NULL OR failure_cost_amount >= 0)
         AND (failure_cost_amount IS NULL) = (failure_cost_read_at IS NULL)
         AND (failure_cost_charge_id IS NULL OR failure_cost_amount > 0));

COMMENT ON COLUMN landlord_gam_debits.failure_cost_amount IS
  '10/12 (G1): what this failed pull actually cost GAM (Stripe''s fee on the debit plus its failure fee), billed to the landlord at cost. NULL = not read from Stripe yet.';
COMMENT ON COLUMN landlord_gam_debits.failure_cost_charge_id IS
  '10/12 (G1): the landlord_gam_charges row (kind bank_debit_failed_cost) that bills failure_cost_amount.';
