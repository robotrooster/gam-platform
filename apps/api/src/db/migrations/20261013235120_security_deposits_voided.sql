-- 10/12 (Nic, G8) — KEEP EVERYTHING: A DEPOSIT RECORD THAT WAS ONLY EVER A
-- PENDING LINE IS VOIDED, NOT DELETED.
--
-- Two places still DELETEd a security_deposits row (lib/unwindIssuedLease): a
-- lease voided before the tenant signed, and a lease closed because the tenant
-- never moved in. Each removed the lease's deposit record when it was still
-- 'pending' with nothing collected — "only ever a pending line, with nothing
-- collected, is not a deposit". The record of what the lease asked for went
-- with it.
--
-- Now it is kept, status 'voided', with
--   voided_at   — when it was taken back
--   void_reason — why, in plain words
-- Only an empty pending record is ever voided (the same rows the DELETE took),
-- and a voided record never changes again. Every reader of a lease's or a
-- tenant's deposit leaves voided records out (status <> 'voided').
--
-- status values match @gam/shared SECURITY_DEPOSIT_STATUSES (appended).
--
-- Expand-only: the CHECK gets wider and the columns are nullable; nothing
-- writes 'voided' before the code ships. No backfill.

ALTER TABLE security_deposits
  ADD COLUMN IF NOT EXISTS voided_at   timestamptz,
  ADD COLUMN IF NOT EXISTS void_reason text;

ALTER TABLE security_deposits DROP CONSTRAINT IF EXISTS security_deposits_status_check;
ALTER TABLE security_deposits ADD CONSTRAINT security_deposits_status_check
  CHECK (status IN ('pending', 'funded', 'partial', 'disbursed', 'claimed', 'voided'));

ALTER TABLE security_deposits DROP CONSTRAINT IF EXISTS security_deposits_voided_is_stamped;
ALTER TABLE security_deposits ADD CONSTRAINT security_deposits_voided_is_stamped
  CHECK ((status = 'voided') = (voided_at IS NOT NULL)
         AND (voided_at IS NULL) = (void_reason IS NULL)
         AND (status <> 'voided' OR COALESCE(collected_amount, 0) = 0));

-- A voided record is a record: what it says never changes again (its status,
-- when and why, what the lease asked for and what was collected, and whose it
-- was). A foreign key letting go of something deleted is not a change of it.
CREATE OR REPLACE FUNCTION security_deposits_voided_is_a_record() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'voided' AND (
       NEW.status IS DISTINCT FROM OLD.status
    OR NEW.voided_at IS DISTINCT FROM OLD.voided_at
    OR NEW.void_reason IS DISTINCT FROM OLD.void_reason
    OR NEW.total_amount IS DISTINCT FROM OLD.total_amount
    OR NEW.collected_amount IS DISTINCT FROM OLD.collected_amount
    OR NEW.lease_id IS DISTINCT FROM OLD.lease_id
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.held_by IS DISTINCT FROM OLD.held_by) THEN
    RAISE EXCEPTION 'Deposit record % was voided: it is a record and does not change', OLD.id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_security_deposits_voided_is_a_record ON security_deposits;
CREATE TRIGGER trg_security_deposits_voided_is_a_record
  BEFORE UPDATE ON security_deposits
  FOR EACH ROW EXECUTE FUNCTION security_deposits_voided_is_a_record();

COMMENT ON COLUMN security_deposits.voided_at IS
  '10/12 (G8): when this deposit record — a pending line with nothing collected, on a lease voided or never moved into — was voided. Kept forever; read by nobody as a deposit.';
COMMENT ON COLUMN security_deposits.void_reason IS
  '10/12 (G8): why the deposit record was voided, in plain words.';
