-- 10/12 (Nic) — GAM BOOKS, PHASE P6: A BANK LINE GOING OUT MATCHES THE RECORD IT ALREADY HAS
--
-- Money out is one record (Nic 10/12, L5; gam-ledger-design-2026-10-12 §12).
-- Money GAM sends or records already has its record — GAM's fee debit, a
-- register refund paid by check, a refund check to a tenant or guest — and an
-- expense the landlord logged (paid by check, or a bill) is already on the
-- Expenses record. The bank line that shows that money leaving MATCHES that
-- record; it never makes a second one. Filing a line as a brand-new expense is
-- for money with no record yet.
--
--   bank_transactions.matched_kind   what a money-out line was matched to
--                                    (BANK_OUT_MATCH_KINDS):
--     expenses     one or several open expenses — each expense's payment names
--                  the line (landlord_expense_payments.bank_transaction_id)
--     gam_debit    GAM's fee debit                 (matched_gam_debit_id)
--     pos_refund   a register refund by check      (matched_pos_refund_id)
--     refund_part  a refund check to a tenant or guest (matched_refund_part_id)
--     transfer     money moved to another of the company's linked accounts
--                  (matched_transfer_line_id: the line it arrived as, when
--                  that account is linked too)
--   matched_at / matched_by          when and by whom (kept when it is undone:
--                                    the change journal holds the old row)
-- A matched line has status 'matched'. Unfile puts it back in review and clears
-- these (its payments are voided, kept on record).
--
-- Each GAM debit, register refund and refund part is matched to at most one
-- live line.
-- Expand-only; safe before the code ships. No backfill needed (nothing was
-- matched this way before).
-- Safe drop: the columns, their CHECKs and indexes.

SET LOCAL lock_timeout = '10s';

ALTER TABLE bank_transactions
  ADD COLUMN IF NOT EXISTS matched_kind              text,
  ADD COLUMN IF NOT EXISTS matched_gam_debit_id      uuid REFERENCES landlord_gam_debits(id),
  ADD COLUMN IF NOT EXISTS matched_pos_refund_id     uuid REFERENCES pos_refunds(id),
  ADD COLUMN IF NOT EXISTS matched_refund_part_id    uuid REFERENCES stay_refund_parts(id),
  ADD COLUMN IF NOT EXISTS matched_transfer_line_id  uuid REFERENCES bank_transactions(id),
  ADD COLUMN IF NOT EXISTS matched_at                timestamptz,
  ADD COLUMN IF NOT EXISTS matched_by                uuid REFERENCES users(id);

ALTER TABLE bank_transactions DROP CONSTRAINT IF EXISTS bank_transactions_matched_kind_check;
ALTER TABLE bank_transactions ADD CONSTRAINT bank_transactions_matched_kind_check
  CHECK (matched_kind IS NULL OR matched_kind IN ('expenses', 'gam_debit', 'pos_refund', 'refund_part', 'transfer'));

-- Each kind names exactly its own record, and only a matched line carries one.
ALTER TABLE bank_transactions DROP CONSTRAINT IF EXISTS bank_transactions_matched_kind_shape;
ALTER TABLE bank_transactions ADD CONSTRAINT bank_transactions_matched_kind_shape CHECK (
  (matched_kind IS NULL OR status = 'matched')
  AND (matched_gam_debit_id IS NULL OR matched_kind = 'gam_debit')
  AND (matched_pos_refund_id IS NULL OR matched_kind = 'pos_refund')
  AND (matched_refund_part_id IS NULL OR matched_kind = 'refund_part')
  AND (matched_transfer_line_id IS NULL OR matched_kind = 'transfer')
  AND (matched_kind IS DISTINCT FROM 'gam_debit' OR matched_gam_debit_id IS NOT NULL)
  AND (matched_kind IS DISTINCT FROM 'pos_refund' OR matched_pos_refund_id IS NOT NULL)
  AND (matched_kind IS DISTINCT FROM 'refund_part' OR matched_refund_part_id IS NOT NULL));

CREATE UNIQUE INDEX IF NOT EXISTS bank_transactions_one_line_per_gam_debit
  ON bank_transactions (matched_gam_debit_id) WHERE matched_gam_debit_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS bank_transactions_one_line_per_pos_refund
  ON bank_transactions (matched_pos_refund_id) WHERE matched_pos_refund_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS bank_transactions_one_line_per_refund_part
  ON bank_transactions (matched_refund_part_id) WHERE matched_refund_part_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS bank_transactions_matched_kind
  ON bank_transactions (landlord_id, matched_kind) WHERE matched_kind IS NOT NULL;

COMMENT ON COLUMN bank_transactions.matched_kind IS
  '10/12 (Nic, L5): what a money-out line was matched to — expenses (their payments name the line), GAM''s fee debit, a register refund or a refund check, or a transfer between the company''s accounts (BANK_OUT_MATCH_KINDS). The line never makes a record of its own.';
