-- decisions #48.5 (orchestrator call 10/4, told to Nic): a charge nobody owes
-- that a payment already touched gets a recorded VOID status. It is kept,
-- never deleted, and left out of every balance.
--
-- WHY. When an amenity reservation is canceled or released, its fee is no
-- longer owed. A fee nothing was ever tried on is simply removed
-- (services/commonAreas voidUnpaidReservationFee). But a fee a card or bank
-- payment was tried on cannot be deleted — receipts (remittance_applications)
-- and return logs point at it, and GAM never deletes a charge a payment
-- touched — and payments had no way to say "not owed". So it was KEPT
-- 'pending'/'failed', inside the household's pay-in-full total: autopay, the
-- tenant's next payment or account credit could collect a fee nobody owed,
-- and an admin alert ('reservation_fee_kept') asked a person to fix it.
--
-- WHAT. One more payments.status value, 'voided', stamped with when and why:
--   voided_at   — when the charge was taken off (NOT NULL exactly when voided)
--   void_reason — the plain reason, kept with the record
-- Every balance, payable and credit rule reads status IN ('pending','failed')
-- (moneyPredicates.payableRowSql, the credit_uses trigger, the delinquency
-- sync), so a voided charge is owed by nobody and paid by nothing.
-- trg_payments_voided_is_a_record keeps it that way: only a charge still owed
-- ('pending' or 'failed') with no credit spent on it can be voided; a voided
-- charge never changes status, amount or stamps again. It is never deleted:
-- every app path that deletes a charge deletes only 'pending'/'failed' rows,
-- and the receipts and return logs that point at it restrict a delete. (A
-- DELETE guard in the trigger is left for later: the test suite's
-- cleanupAllSchema deletes every payments row and cannot yet switch it off.)
--
-- packages/shared PAYMENT_STATUSES / PAYMENT_STATUS_LABEL must list 'voided'
-- ("Voided") to match this CHECK (single source of truth for enums).
--
-- Expand-only: two nullable columns, a widened CHECK (every existing row
-- already passes), a new CHECK every existing row passes (no row is voided),
-- and a guard trigger. No backfill needed (production has 0 reservation fees
-- in this state).

ALTER TABLE payments ADD COLUMN IF NOT EXISTS voided_at timestamp with time zone;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS void_reason text;

COMMENT ON COLUMN payments.voided_at IS
  'decisions #48.5: when a charge nobody owes, that a payment had already touched, was taken off (status voided). NOT NULL exactly when status = voided. The row is kept forever and left out of every balance.';
COMMENT ON COLUMN payments.void_reason IS
  'decisions #48.5: the plain reason a voided charge is no longer owed (e.g. the reservation it was for was canceled). Set with voided_at.';

ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_status_check;
ALTER TABLE payments ADD CONSTRAINT payments_status_check CHECK ((status = ANY (ARRAY[
  'pending'::text, 'processing'::text, 'settled'::text, 'failed'::text, 'returned'::text,
  'paid_via_deposit'::text, 'voided'::text])));

ALTER TABLE payments ADD CONSTRAINT payments_voided_is_stamped CHECK ((
  ((status = 'voided'::text) = (voided_at IS NOT NULL))
  AND ((voided_at IS NULL) = (void_reason IS NULL))));

CREATE OR REPLACE FUNCTION public.payments_voided_is_a_record() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.status = 'voided' THEN
    IF NEW.status <> 'voided' OR NEW.amount <> OLD.amount
       OR NEW.voided_at IS DISTINCT FROM OLD.voided_at
       OR NEW.void_reason IS DISTINCT FROM OLD.void_reason THEN
      RAISE EXCEPTION 'Charge % was voided: it is a record and does not change', OLD.id
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status = 'voided' THEN
    -- Only a charge still owed is taken off: a paid, clearing, returned or
    -- paid-from-deposit charge has money behind it and is refunded instead.
    IF OLD.status NOT IN ('pending', 'failed') THEN
      RAISE EXCEPTION 'Charge % is %, not owed: only a charge still owed can be voided', OLD.id, OLD.status
        USING ERRCODE = '23514';
    END IF;
    -- Credit spent on it is given back first, so no spent credit is left on a
    -- charge nobody owes. (Credit a bank retry set aside on it is that pull's
    -- and is given back when the pull ends: a pull carrying a voided charge is
    -- never sent again — services/achRetry treats it as paid another way.)
    IF EXISTS (SELECT 1 FROM credit_uses u WHERE u.payment_id = OLD.id AND u.status = 'applied') THEN
      RAISE EXCEPTION 'Charge % has account credit spent on it; give the credit back before voiding it', OLD.id
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_payments_voided_is_a_record ON payments;
CREATE TRIGGER trg_payments_voided_is_a_record
  BEFORE UPDATE OF status, amount, voided_at, void_reason ON public.payments
  FOR EACH ROW EXECUTE FUNCTION public.payments_voided_is_a_record();
