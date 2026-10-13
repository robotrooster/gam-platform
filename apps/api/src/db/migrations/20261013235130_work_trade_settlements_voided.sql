-- 10/12 (Nic, G8) — KEEP EVERYTHING: AN OPEN WORK-TRADE PERIOD ON A BILL THAT
-- WILL NEVER BE OWED IS VOIDED, NOT DELETED.
--
-- Three places still DELETEd a work_trade_settlements row: a lease voided
-- before the tenant signed (lib/unwindIssuedLease), and a new lease that will
-- never start (services/renewalSuccessor, twice). Each removed the bill's open
-- settlement period — "a settlement period on a void invoice has nothing left
-- to credit" — and with it the record of the hours the period asked for and
-- the rate they were priced at.
--
-- Now it is kept, status 'voided', with
--   voided_at   — when it was taken back
--   void_reason — why, in plain words
-- Only an 'open' period is ever voided (the same rows the DELETE took), and a
-- voided period never changes again. Every reader leaves voided periods out:
-- the close reads 'open' ones, the standing and reports read 'settled' or
-- 'billed' ones, and the coverage check that reads every period now says
-- status <> 'voided'.
--
-- The period keeps its (agreement, start) slot (ux_work_trade_settlements_
-- agreement_start, which three writers target with ON CONFLICT and so cannot
-- become partial). That is safe: every void here is on an agreement that ends
-- with its lease (the void ends it; a new lease that never starts never bills),
-- and a re-signed lease gets a new agreement and so a new slot.
--
-- Expand-only: the CHECK gets wider and the columns are nullable; nothing
-- writes 'voided' before the code ships. No backfill.

ALTER TABLE work_trade_settlements
  ADD COLUMN IF NOT EXISTS voided_at   timestamptz,
  ADD COLUMN IF NOT EXISTS void_reason text;

ALTER TABLE work_trade_settlements DROP CONSTRAINT IF EXISTS work_trade_settlements_status_check;
ALTER TABLE work_trade_settlements ADD CONSTRAINT work_trade_settlements_status_check
  CHECK (status IN ('open', 'settled', 'billed', 'voided'));

ALTER TABLE work_trade_settlements DROP CONSTRAINT IF EXISTS work_trade_settlements_voided_is_stamped;
ALTER TABLE work_trade_settlements ADD CONSTRAINT work_trade_settlements_voided_is_stamped
  CHECK ((status = 'voided') = (voided_at IS NOT NULL)
         AND (voided_at IS NULL) = (void_reason IS NULL));

-- What a voided period says never changes again: its status, when and why,
-- and the hours, rate and money it was priced at. (A foreign key letting go of
-- a deleted bill — invoice_id ON DELETE SET NULL — is not a change of it.)
CREATE OR REPLACE FUNCTION work_trade_settlements_voided_is_a_record() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'voided' AND (
       NEW.status IS DISTINCT FROM OLD.status
    OR NEW.voided_at IS DISTINCT FROM OLD.voided_at
    OR NEW.void_reason IS DISTINCT FROM OLD.void_reason
    OR NEW.target_hours IS DISTINCT FROM OLD.target_hours
    OR NEW.hours_worked IS DISTINCT FROM OLD.hours_worked
    OR NEW.hours_applied IS DISTINCT FROM OLD.hours_applied
    OR NEW.hour_rate IS DISTINCT FROM OLD.hour_rate
    OR NEW.basis_amount IS DISTINCT FROM OLD.basis_amount
    OR NEW.credit_applied IS DISTINCT FROM OLD.credit_applied
    OR NEW.period_start IS DISTINCT FROM OLD.period_start
    OR NEW.period_end IS DISTINCT FROM OLD.period_end
    OR NEW.close_run_at IS DISTINCT FROM OLD.close_run_at) THEN
    RAISE EXCEPTION 'Work-trade period % was voided: it is a record and does not change', OLD.id
      USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'voided' AND OLD.status <> 'voided' AND OLD.status <> 'open' THEN
    RAISE EXCEPTION 'Work-trade period % is %, not open: only an open period can be voided', OLD.id, OLD.status
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_work_trade_settlements_voided_is_a_record ON work_trade_settlements;
CREATE TRIGGER trg_work_trade_settlements_voided_is_a_record
  BEFORE UPDATE ON work_trade_settlements
  FOR EACH ROW EXECUTE FUNCTION work_trade_settlements_voided_is_a_record();

COMMENT ON COLUMN work_trade_settlements.voided_at IS
  '10/12 (G8): when this open period was voided (its bill will never be owed: a lease voided before signing, or a new lease that never starts). Kept forever; credits nothing.';
COMMENT ON COLUMN work_trade_settlements.void_reason IS
  '10/12 (G8): why the period was voided, in plain words.';
