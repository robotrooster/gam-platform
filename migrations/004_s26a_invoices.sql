-- Migration 004: S26a — Invoice infrastructure
-- Creates invoices table, per-landlord-per-year numbering sequence,
-- status rollup trigger. Wipes payments rows (Option A — reseed later).
-- Drops payments.parent_payment_id (unused, replaced by invoice_id).

BEGIN;

-- 1. Wipe payments rows — clean slate
DELETE FROM payments;

-- 2. Drop parent_payment_id (replaced by invoice_id)
ALTER TABLE payments DROP CONSTRAINT payments_parent_payment_id_fkey;
DROP INDEX IF EXISTS idx_payments_parent_payment_id;
ALTER TABLE payments DROP COLUMN parent_payment_id;

-- 3. Create invoices table
CREATE TABLE invoices (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  landlord_id         UUID NOT NULL REFERENCES landlords(id) ON DELETE RESTRICT,
  tenant_id           UUID REFERENCES tenants(id) ON DELETE SET NULL,
  lease_id            UUID NOT NULL REFERENCES leases(id) ON DELETE RESTRICT,
  unit_id             UUID NOT NULL REFERENCES units(id) ON DELETE RESTRICT,
  invoice_number      TEXT NOT NULL,
  due_date            DATE NOT NULL,
  subtotal_rent       NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (subtotal_rent >= 0),
  subtotal_fees       NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (subtotal_fees >= 0),
  subtotal_utilities  NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (subtotal_utilities >= 0),
  subtotal_deposits   NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (subtotal_deposits >= 0),
  subtotal_late_fees  NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (subtotal_late_fees >= 0),
  total_amount        NUMERIC(12,2) NOT NULL CHECK (total_amount >= 0),
  status              TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','partial','settled','void')),
  sent_at             TIMESTAMPTZ,
  viewed_at           TIMESTAMPTZ,
  pdf_url             TEXT,
  notes               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX ux_invoices_lease_due_date ON invoices (lease_id, due_date);
CREATE UNIQUE INDEX ux_invoices_landlord_number ON invoices (landlord_id, invoice_number);
CREATE INDEX idx_invoices_landlord ON invoices (landlord_id);
CREATE INDEX idx_invoices_tenant ON invoices (tenant_id);
CREATE INDEX idx_invoices_lease ON invoices (lease_id);
CREATE INDEX idx_invoices_unit ON invoices (unit_id);
CREATE INDEX idx_invoices_due_date ON invoices (due_date);
CREATE INDEX idx_invoices_status ON invoices (status);

-- 4. Per-landlord-per-year invoice numbering
CREATE TABLE invoice_sequences (
  landlord_id  UUID NOT NULL REFERENCES landlords(id) ON DELETE CASCADE,
  year         INTEGER NOT NULL,
  next_number  INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (landlord_id, year)
);

-- 5. Add invoice_id to payments
ALTER TABLE payments
  ADD COLUMN invoice_id UUID REFERENCES invoices(id) ON DELETE RESTRICT;
CREATE INDEX idx_payments_invoice_id ON payments (invoice_id);

-- 6. Status rollup helper (called by trigger)
CREATE OR REPLACE FUNCTION fn_invoice_status_rollup_single(p_invoice_id UUID)
RETURNS VOID AS $BODY$
DECLARE
  v_total_children   INTEGER;
  v_settled_children INTEGER;
  v_current_status   TEXT;
  v_new_status       TEXT;
BEGIN
  SELECT status INTO v_current_status FROM invoices WHERE id = p_invoice_id;
  IF v_current_status = 'void' THEN
    RETURN;
  END IF;

  SELECT
    COUNT(*),
    COUNT(*) FILTER (WHERE status = 'settled')
  INTO v_total_children, v_settled_children
  FROM payments
  WHERE invoice_id = p_invoice_id;

  IF v_total_children = 0 THEN
    v_new_status := 'pending';
  ELSIF v_settled_children = 0 THEN
    v_new_status := 'pending';
  ELSIF v_settled_children = v_total_children THEN
    v_new_status := 'settled';
  ELSE
    v_new_status := 'partial';
  END IF;

  IF v_new_status IS DISTINCT FROM v_current_status THEN
    UPDATE invoices
    SET status = v_new_status, updated_at = now()
    WHERE id = p_invoice_id;
  END IF;
END;
$BODY$ LANGUAGE plpgsql;

-- 7. Trigger function dispatches to helper for old and/or new invoice
CREATE OR REPLACE FUNCTION fn_invoice_status_rollup()
RETURNS TRIGGER AS $BODY$
BEGIN
  IF (TG_OP = 'DELETE') THEN
    IF OLD.invoice_id IS NOT NULL THEN
      PERFORM fn_invoice_status_rollup_single(OLD.invoice_id);
    END IF;
    RETURN OLD;
  END IF;

  IF (TG_OP = 'UPDATE' AND OLD.invoice_id IS DISTINCT FROM NEW.invoice_id
      AND OLD.invoice_id IS NOT NULL) THEN
    PERFORM fn_invoice_status_rollup_single(OLD.invoice_id);
  END IF;

  IF NEW.invoice_id IS NOT NULL THEN
    PERFORM fn_invoice_status_rollup_single(NEW.invoice_id);
  END IF;

  RETURN NEW;
END;
$BODY$ LANGUAGE plpgsql;

CREATE TRIGGER trg_payments_invoice_status_rollup
AFTER INSERT OR UPDATE OF status, invoice_id OR DELETE ON payments
FOR EACH ROW
EXECUTE FUNCTION fn_invoice_status_rollup();

-- 8. updated_at auto-maintenance on invoices
CREATE OR REPLACE FUNCTION fn_invoices_updated_at()
RETURNS TRIGGER AS $BODY$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$BODY$ LANGUAGE plpgsql;

CREATE TRIGGER trg_invoices_updated_at
BEFORE UPDATE ON invoices
FOR EACH ROW
EXECUTE FUNCTION fn_invoices_updated_at();

COMMIT;
