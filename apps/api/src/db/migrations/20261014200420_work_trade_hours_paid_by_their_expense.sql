-- 10/12 (Nic) — GAM BOOKS, PHASE P7: PAYING A WORK TRADER'S CONTRACTOR BILL PAYS THEIR EXTRA HOURS
--
-- Nic, 10/12: paid extra work-trade hours are wages the landlord pays a person,
-- by hand (Mark paid on the Work Trade page) or through GAM Books — as payroll
-- (W-2) or a contractor payment (1099). Money out is ONE record (L5): a 1099
-- record becomes an unpaid contractor expense on the Expenses record when the
-- person paying confirms it (services/workTradeBooksPay; the expense names the
-- record, landlord_expenses.work_trade_extra_hours_id, and the record names the
-- expense, work_trade_extra_hours.books_reference_id).
--
-- That expense is paid wherever money out is recorded — a bank line matched to
-- it, a check or cash recorded on the Expenses page, a split — and taken back
-- the same ways (a payment voided, a match undone). Whichever way, the Work
-- Trade page must say the same thing as the books. So the record follows its
-- expense's payments, here, for every path at once:
--   - paid in full (its live payments reach the expense's amount): the record
--     is 'paid', paid_how 'gam_books' (WORK_TRADE_EXTRA_PAID_HOW_RECORDED),
--     paid_on the day of the payment that finished it, paid_by who recorded it;
--   - no longer paid in full (a payment voided): back to 'sent_to_books', the
--     paid stamps cleared, still naming its expense.
-- Only a record whose books_reference_id is this expense moves, and only
-- between those two states: a record paid by hand (check or cash) or through a
-- payroll run is never touched. A plain row trigger in the payment's own
-- transaction (a few rows at most); it writes nothing when nothing changes.
--
-- Expand-only; safe before the code ships (no record names an expense yet).
-- No backfill needed (nothing has been paid in GAM Books yet).
-- Safe drop: the trigger and its function.

SET LOCAL lock_timeout = '10s';

CREATE OR REPLACE FUNCTION work_trade_hours_follow_their_expense() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  e        record;
  paid     numeric;
  last_day date;
  last_by  uuid;
BEGIN
  SELECT x.id, x.amount, x.status, x.work_trade_extra_hours_id INTO e
    FROM landlord_expenses x WHERE x.id = NEW.expense_id;
  IF e.work_trade_extra_hours_id IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT COALESCE(sum(p.amount), 0), max(p.paid_on) INTO paid, last_day
    FROM landlord_expense_payments p WHERE p.expense_id = e.id AND p.voided_at IS NULL;
  IF e.status = 'active' AND paid >= e.amount AND paid > 0 THEN
    SELECT p.created_by INTO last_by FROM landlord_expense_payments p
     WHERE p.expense_id = e.id AND p.voided_at IS NULL
     ORDER BY p.paid_on DESC, p.created_at DESC LIMIT 1;
    UPDATE work_trade_extra_hours
       SET status = 'paid', paid_on = last_day, paid_at = now(), paid_by = last_by, paid_how = 'gam_books',
           paid_note = 'Paid in GAM Books (contractor payment)', updated_at = now()
     WHERE id = e.work_trade_extra_hours_id AND books_reference_id = e.id AND status = 'sent_to_books';
  ELSE
    UPDATE work_trade_extra_hours
       SET status = 'sent_to_books', paid_on = NULL, paid_at = NULL, paid_by = NULL, paid_how = NULL,
           paid_note = NULL, updated_at = now()
     WHERE id = e.work_trade_extra_hours_id AND books_reference_id = e.id AND status = 'paid' AND paid_how = 'gam_books';
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS work_trade_hours_follow_their_expense ON landlord_expense_payments;
CREATE TRIGGER work_trade_hours_follow_their_expense
  AFTER INSERT OR UPDATE OF amount, voided_at ON landlord_expense_payments
  FOR EACH ROW EXECUTE FUNCTION work_trade_hours_follow_their_expense();

COMMENT ON FUNCTION work_trade_hours_follow_their_expense() IS
  '10/12 (Nic, ledger P7): a work trader''s extra hours paid as a contractor (1099) are paid when the contractor expense they became is paid in full, and waiting again when it no longer is.';
