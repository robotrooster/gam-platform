-- S655 money plan M8 (Step 1), K-B. Expand-only: two new tables.
--
-- Nic (10/2): "Make a bank deposit". Staff tick what went in the bag: recorded
-- receipts (cash, checks, money orders) and register sales, plus anything GAM
-- never recorded (other_amount, with a note; the form asks "Is any of this
-- rent? Record it first."). A bank row equal to the total within 5 business
-- days matches the slip; the extra is filed as other income.
--
-- Slip items are RECEIPTS, not charge rows: a $500 cash receipt that paid $460
-- and kept $40 as credit is $500 in the bag. A receipt can be in only one live
-- slip at a time.
CREATE TABLE bank_deposit_slips (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  landlord_id         uuid NOT NULL REFERENCES landlords(id),
  property_id         uuid REFERENCES properties(id),
  deposit_date        date NOT NULL,
  total               numeric(12,2) NOT NULL,
  other_amount        numeric(12,2) NOT NULL DEFAULT 0,
  other_note          text,
  source              text NOT NULL DEFAULT 'staff',
  status              text NOT NULL DEFAULT 'open',
  bank_transaction_id uuid REFERENCES bank_transactions(id),
  created_by          uuid REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  matched_at          timestamptz,
  voided_at           timestamptz,
  CONSTRAINT bank_deposit_slips_total_positive   CHECK (total > 0),
  CONSTRAINT bank_deposit_slips_other_nonneg     CHECK (other_amount >= 0),
  CONSTRAINT bank_deposit_slips_other_needs_note CHECK (other_amount = 0 OR btrim(COALESCE(other_note,'')) <> ''),
  -- Mirrored by DEPOSIT_SLIP_SOURCES / DEPOSIT_SLIP_STATUSES in packages/shared/src/money.ts.
  CONSTRAINT bank_deposit_slips_source_check     CHECK (source IN ('staff','inferred')),
  CONSTRAINT bank_deposit_slips_staff_has_author CHECK (source <> 'staff' OR created_by IS NOT NULL),
  CONSTRAINT bank_deposit_slips_status_check     CHECK (status IN ('open','matched','void')),
  CONSTRAINT bank_deposit_slips_matched_has_txn  CHECK (status <> 'matched' OR (bank_transaction_id IS NOT NULL AND matched_at IS NOT NULL)),
  CONSTRAINT bank_deposit_slips_void_stamped     CHECK (status <> 'void' OR voided_at IS NOT NULL)
);
CREATE UNIQUE INDEX ux_bank_deposit_slips_txn ON bank_deposit_slips (bank_transaction_id) WHERE status = 'matched';
CREATE INDEX idx_bank_deposit_slips_open ON bank_deposit_slips (landlord_id, deposit_date) WHERE status = 'open';
COMMENT ON TABLE bank_deposit_slips IS
  'S655 (Nic): "Make a bank deposit". What staff put in the bag: recorded receipts plus anything GAM never recorded (other_amount, with a note; the form asks "Is any of this rent? Record it first."). A bank row equal to the total within 5 business days matches it; the extra is filed as other income.';

CREATE TABLE bank_deposit_slip_items (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slip_id            uuid NOT NULL REFERENCES bank_deposit_slips(id),
  remittance_id      uuid REFERENCES tenant_remittances(id),
  pos_transaction_id uuid REFERENCES pos_transactions(id),
  amount             numeric(12,2) NOT NULL,
  voided_at          timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bank_deposit_slip_items_amount_positive CHECK (amount > 0),
  CONSTRAINT bank_deposit_slip_items_one_source CHECK (num_nonnulls(remittance_id, pos_transaction_id) = 1)
);
CREATE UNIQUE INDEX ux_slip_items_remittance_live ON bank_deposit_slip_items (remittance_id)
  WHERE remittance_id IS NOT NULL AND voided_at IS NULL;
CREATE UNIQUE INDEX ux_slip_items_pos_live ON bank_deposit_slip_items (pos_transaction_id)
  WHERE pos_transaction_id IS NOT NULL AND voided_at IS NULL;
CREATE INDEX idx_slip_items_slip ON bank_deposit_slip_items (slip_id);
COMMENT ON TABLE bank_deposit_slip_items IS
  'S655: one receipt (tenant_remittances) or register sale (pos_transactions) in a deposit slip, at the full amount handed over. Live in one slip at a time; removing it from a slip stamps voided_at.';
CREATE TRIGGER audit_bank_deposit_slips AFTER DELETE OR UPDATE ON bank_deposit_slips
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();
CREATE TRIGGER audit_bank_deposit_slip_items AFTER DELETE OR UPDATE ON bank_deposit_slip_items
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();
