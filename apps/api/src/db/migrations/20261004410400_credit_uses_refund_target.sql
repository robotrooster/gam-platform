-- 10/4 (decisions #38 Q8): paid-ahead money from a long stay's early check-out
-- can be REFUNDED, and the refund is a spend of that credit like any other.
--
-- Nic (#38 Q8): a long stay on a lease is never billed past the day the guest
-- leaves; leaving ends the lease that day, and rent already paid past it
-- becomes money paid ahead (services/bookingLeaseBilling banks it,
-- funded_by 'reclassified'). That money gets the refund choices — "Refund the
-- unused nights" / "Refund a different amount" — and a refund goes back the
-- way the rent was paid (a card to that card, a bank payment to the bank,
-- cash at the desk). What is refunded must come off the credit, recorded, or
-- the same dollars could pay a later bill or the move-out pool too.
--
-- credit_uses is THE record of every spend of a credit (S655), and
-- amount_remaining moves only through trg_credit_uses_apply. So a refund is a
-- use whose target is the refund part (stay_refund_parts) instead of a
-- charge, a move-out or a clawback:
--   - credit_uses.refund_part_id (new, nullable);
--   - credit_uses_one_target counts it as a target;
--   - credit_uses_source_check gains 'refund';
--   - credit_uses_refund_is_paid_ahead: only paid-ahead money is refunded this
--     way, and only with source 'refund' (the same shape as the move-out and
--     clawback targets);
--   - "a use is a record" covers the new column: a use's refund target never
--     changes. Enforced by its OWN small trigger (trg_credit_uses_refund_target_fixed)
--     rather than by re-creating credit_uses_apply() with one more line — that
--     function's body belongs to 20261003100300_credit_uses_ledger.sql (and
--     whatever later migration changes it); restating it here would silently
--     overwrite any newer body on deploy (fix round 1: it had dropped the
--     move-out deposit-interest guard).
--
-- Expand-only: a new nullable column, CHECKs that accept every existing row,
-- and one new trigger that only refuses an UPDATE moving refund_part_id. No
-- backfill needed.
ALTER TABLE credit_uses ADD COLUMN IF NOT EXISTS refund_part_id uuid
  REFERENCES stay_refund_parts(id) ON DELETE RESTRICT;

ALTER TABLE credit_uses DROP CONSTRAINT IF EXISTS credit_uses_one_target;
ALTER TABLE credit_uses ADD CONSTRAINT credit_uses_one_target CHECK (
  num_nonnulls(payment_id, deposit_return_id, payment_reversal_id, refund_part_id) = 1
  OR (status = 'released' AND num_nonnulls(payment_id, deposit_return_id, payment_reversal_id, refund_part_id) = 0));

ALTER TABLE credit_uses DROP CONSTRAINT IF EXISTS credit_uses_source_check;
ALTER TABLE credit_uses ADD CONSTRAINT credit_uses_source_check CHECK (source IN (
  'portal', 'autopay', 'front_desk_reader', 'desk', 'landlord_agent', 'whole_bill', 'move_out', 'reversal', 'backfill', 'refund'));

ALTER TABLE credit_uses DROP CONSTRAINT IF EXISTS credit_uses_refund_is_paid_ahead;
ALTER TABLE credit_uses ADD CONSTRAINT credit_uses_refund_is_paid_ahead CHECK (
  refund_part_id IS NULL OR (prepaid_credit_id IS NOT NULL AND source = 'refund'));

CREATE INDEX IF NOT EXISTS credit_uses_refund_part_idx ON credit_uses (refund_part_id) WHERE refund_part_id IS NOT NULL;

CREATE OR REPLACE FUNCTION credit_uses_refund_target_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Fires only when refund_part_id moves (the trigger's WHEN): a use's target
  -- is part of what the use IS, like the other targets credit_uses_apply guards.
  RAISE EXCEPTION 'A credit use is a record: only its status moves' USING ERRCODE = '23514';
END $$;
DROP TRIGGER IF EXISTS trg_credit_uses_refund_target_fixed ON credit_uses;
CREATE TRIGGER trg_credit_uses_refund_target_fixed BEFORE UPDATE ON credit_uses
  FOR EACH ROW WHEN (NEW.refund_part_id IS DISTINCT FROM OLD.refund_part_id)
  EXECUTE FUNCTION credit_uses_refund_target_fixed();
