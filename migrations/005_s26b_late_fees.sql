-- migrations/005_s26b_late_fees.sql
-- S26b: Late fee engine support.
-- Adds partial unique index for late_fee idempotency and a
-- subtotal_late_fees rollup trigger. CHECK constraints on
-- leases.late_fee_* already exist with 'percent_of_rent' canonical.

BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS ux_payments_late_fee_idempotent
ON payments (invoice_id, due_date)
WHERE type = 'late_fee'
  AND status IN ('pending', 'processing', 'settled');

CREATE OR REPLACE FUNCTION fn_invoice_late_fee_subtotal_rollup_single(p_invoice_id INT)
RETURNS VOID AS $$
BEGIN
  UPDATE invoices
  SET subtotal_late_fees = COALESCE((
    SELECT SUM(amount)
    FROM payments
    WHERE invoice_id = p_invoice_id
      AND type = 'late_fee'
      AND status IN ('pending', 'processing', 'settled')
  ), 0)
  WHERE id = p_invoice_id;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION fn_invoice_late_fee_subtotal_rollup_trigger()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.type = 'late_fee' AND NEW.invoice_id IS NOT NULL THEN
      PERFORM fn_invoice_late_fee_subtotal_rollup_single(NEW.invoice_id);
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    IF OLD.type = 'late_fee' AND OLD.invoice_id IS NOT NULL THEN
      PERFORM fn_invoice_late_fee_subtotal_rollup_single(OLD.invoice_id);
    END IF;
    IF NEW.type = 'late_fee' AND NEW.invoice_id IS NOT NULL
       AND (OLD.type IS DISTINCT FROM 'late_fee'
            OR OLD.invoice_id IS DISTINCT FROM NEW.invoice_id) THEN
      PERFORM fn_invoice_late_fee_subtotal_rollup_single(NEW.invoice_id);
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD.type = 'late_fee' AND OLD.invoice_id IS NOT NULL THEN
      PERFORM fn_invoice_late_fee_subtotal_rollup_single(OLD.invoice_id);
    END IF;
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_payments_invoice_late_fee_subtotal_rollup ON payments;

CREATE TRIGGER trg_payments_invoice_late_fee_subtotal_rollup
AFTER INSERT OR UPDATE OR DELETE ON payments
FOR EACH ROW
EXECUTE FUNCTION fn_invoice_late_fee_subtotal_rollup_trigger();

COMMIT;
