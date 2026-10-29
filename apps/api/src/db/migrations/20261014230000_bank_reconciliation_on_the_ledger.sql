-- 10/12 (Nic) — GAM BOOKS LEDGER, PHASE P9: BANK RECONCILIATION ON THE LEDGER
--
-- Nic's decision 2 (gam-ledger-design-2026-10-12 §1, §13): bookkeepers do full
-- bookkeeping, reconciling included. A bank account is reconciled against its
-- statement the way QuickBooks does it, on the company's own ledger:
--
--   bank_reconciliations  one row per statement worked, per bank account of
--                         the chart (account_id, which already references
--                         books_accounts). Ledger reconciliations name their
--                         statement_date; the old S568 rows (a statement total
--                         against what GAM paid out, statement_date NULL) stay
--                         as they were — production and demo have none.
--     statement_date      the statement's last day
--     statement_balance   its ending balance (existing column)
--     beginning_balance   the cleared balance carried in from the last
--                         completed reconciliation of the account
--     cleared_balance     beginning + every line cleared on this statement,
--                         written when it completes (must equal the statement)
--     ledger_balance      the account's ledger balance on the statement date
--                         (everything on the books, cleared or not)
--     book_balance        (existing) = cleared_balance for a ledger
--                         reconciliation, so difference reads $0.00 once done
--     status              open → completed, or undone (an open one set aside,
--                         or the latest completed one taken back — never
--                         inside a closed month, services/bankReconciliation).
--                         BANK_RECONCILIATION_STATUSES.
--     opened_by / completed_by / undone_at / undone_by / undo_reason
--
--   bank_reconciliation_items  each ledger line cleared on a statement:
--     ledger_line_id      the line (ledger_posting_lines, append-only)
--     amount              its debit − credit (money into the bank is +)
--     day                 its own day (intended_date — the bank's day)
--     bank_transaction_id the bank line it came from, when the feed matched
--                         or filed it (those arrive ticked)
--     source              BANK_RECONCILIATION_ITEM_SOURCES: bank_line,
--                         ticked, opening, cancels_out
--     released_*          a tick taken off while the statement is open
--                         ('unticked'), or every item of a reconciliation
--                         that was undone ('reconciliation_undone').
--                         BANK_RECONCILIATION_ITEM_RELEASES. A released item
--                         is kept; the line is free to clear again.
--
-- FROZEN. A line is cleared at most once (one live item per line). Items are
-- added and unticked only while their reconciliation is open; completing it
-- freezes them — nothing about them changes again unless the whole
-- reconciliation is undone, which releases them all. Nothing is ever deleted
-- (keep-everything); a completed reconciliation's figures never change.
--
-- Money tables: the change-journal trigger on the new items table from the
-- start (CLAUDE.md, 10/12); bank_reconciliations has had one since
-- 20261013100000.
--
-- The ledger is DARK on production (no screen reconciles on it until the code
-- ships). Expand-only: nullable columns, a new table, CHECKs that every
-- existing row passes (production and demo: 0 rows), and guards that touch
-- only ledger reconciliations (statement_date set), which no old code writes.
-- No backfill needed (no ledger reconciliation exists).
-- Safe drop: bank_reconciliation_items, the two guard functions and triggers,
-- the new columns, the CHECKs and the two indexes.

SET LOCAL lock_timeout = '10s';

ALTER TABLE bank_reconciliations
  ADD COLUMN IF NOT EXISTS statement_date     date,
  ADD COLUMN IF NOT EXISTS beginning_balance  numeric(14,2),
  ADD COLUMN IF NOT EXISTS cleared_balance    numeric(14,2),
  ADD COLUMN IF NOT EXISTS ledger_balance     numeric(14,2),
  ADD COLUMN IF NOT EXISTS opened_by          uuid REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS completed_by       uuid REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS undone_at          timestamptz,
  ADD COLUMN IF NOT EXISTS undone_by          uuid REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS undo_reason        text;

ALTER TABLE bank_reconciliations DROP CONSTRAINT IF EXISTS bank_reconciliations_status_check;
ALTER TABLE bank_reconciliations DROP CONSTRAINT IF EXISTS bank_reconciliations_ledger_names_account;
ALTER TABLE bank_reconciliations DROP CONSTRAINT IF EXISTS bank_reconciliations_undo_says_why;
ALTER TABLE bank_reconciliations DROP CONSTRAINT IF EXISTS bank_reconciliations_completed_has_figures;
ALTER TABLE bank_reconciliations
  ADD CONSTRAINT bank_reconciliations_status_check
    CHECK (status IN ('open', 'completed', 'undone')) NOT VALID,
  ADD CONSTRAINT bank_reconciliations_ledger_names_account
    CHECK (statement_date IS NULL OR (account_id IS NOT NULL AND period_end = statement_date)) NOT VALID,
  ADD CONSTRAINT bank_reconciliations_undo_says_why
    CHECK (status <> 'undone' OR statement_date IS NULL
           OR (undone_at IS NOT NULL AND length(btrim(COALESCE(undo_reason, ''))) > 0)) NOT VALID,
  ADD CONSTRAINT bank_reconciliations_completed_has_figures
    CHECK (statement_date IS NULL OR status <> 'completed'
           OR (completed_at IS NOT NULL AND cleared_balance IS NOT NULL AND cleared_balance = statement_balance)) NOT VALID;
ALTER TABLE bank_reconciliations VALIDATE CONSTRAINT bank_reconciliations_status_check;
ALTER TABLE bank_reconciliations VALIDATE CONSTRAINT bank_reconciliations_ledger_names_account;
ALTER TABLE bank_reconciliations VALIDATE CONSTRAINT bank_reconciliations_undo_says_why;
ALTER TABLE bank_reconciliations VALIDATE CONSTRAINT bank_reconciliations_completed_has_figures;

-- One statement in progress per bank account at a time.
CREATE UNIQUE INDEX IF NOT EXISTS bank_reconciliations_one_open
  ON bank_reconciliations (account_id) WHERE status = 'open' AND statement_date IS NOT NULL;
CREATE INDEX IF NOT EXISTS bank_reconciliations_account_done
  ON bank_reconciliations (account_id, statement_date DESC) WHERE status = 'completed' AND statement_date IS NOT NULL;

COMMENT ON COLUMN bank_reconciliations.statement_date IS
  '10/12 (Nic, ledger P9): the statement''s last day. Set = a reconciliation on the ledger (account_id is the books account); NULL = an S568 statement-total check.';
COMMENT ON COLUMN bank_reconciliations.cleared_balance IS
  '10/12 (Nic, ledger P9): beginning balance + every ledger line cleared on this statement; equals statement_balance when completed.';
COMMENT ON COLUMN bank_reconciliations.ledger_balance IS
  '10/12 (Nic, ledger P9): the account''s ledger balance on the statement date (cleared or not).';

-- A ledger reconciliation's own rules: its account and company never move; a
-- completed one changes only by being undone (with why), and an undone one
-- never changes again; none is ever deleted.
CREATE OR REPLACE FUNCTION bank_reconciliations_ledger_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.statement_date IS NOT NULL THEN
      RAISE EXCEPTION 'A bank reconciliation is kept on record; undo it instead of removing it.'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.statement_date IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.account_id IS DISTINCT FROM OLD.account_id OR NEW.landlord_id IS DISTINCT FROM OLD.landlord_id
     OR NEW.business_id IS DISTINCT FROM OLD.business_id OR NEW.statement_date IS NULL THEN
    RAISE EXCEPTION 'A bank reconciliation stays on its own bank account and company.'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'undone' THEN
    RAISE EXCEPTION 'An undone bank reconciliation is kept as it was.'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'completed' THEN
    IF NEW.status <> 'undone'
       OR NEW.statement_date IS DISTINCT FROM OLD.statement_date
       OR NEW.statement_balance IS DISTINCT FROM OLD.statement_balance
       OR NEW.beginning_balance IS DISTINCT FROM OLD.beginning_balance
       OR NEW.cleared_balance IS DISTINCT FROM OLD.cleared_balance
       OR NEW.ledger_balance IS DISTINCT FROM OLD.ledger_balance
       OR NEW.book_balance IS DISTINCT FROM OLD.book_balance
       OR NEW.period_start IS DISTINCT FROM OLD.period_start
       OR NEW.period_end IS DISTINCT FROM OLD.period_end
       OR NEW.completed_at IS DISTINCT FROM OLD.completed_at
       OR NEW.completed_by IS DISTINCT FROM OLD.completed_by THEN
      RAISE EXCEPTION 'A completed bank reconciliation is frozen; undo it to work the statement again.'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS bank_reconciliations_ledger_guard ON bank_reconciliations;
CREATE TRIGGER bank_reconciliations_ledger_guard
  BEFORE UPDATE OR DELETE ON bank_reconciliations
  FOR EACH ROW EXECUTE FUNCTION bank_reconciliations_ledger_guard();

CREATE TABLE IF NOT EXISTS bank_reconciliation_items (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reconciliation_id    uuid NOT NULL REFERENCES bank_reconciliations(id),
  landlord_id          uuid REFERENCES landlords(id),
  business_id          uuid REFERENCES businesses(id),
  account_id           uuid NOT NULL REFERENCES books_accounts(id),
  ledger_line_id       uuid NOT NULL REFERENCES ledger_posting_lines(id),
  amount               numeric(14,2) NOT NULL,
  day                  date NOT NULL,
  bank_transaction_id  uuid REFERENCES bank_transactions(id),
  source               text NOT NULL,
  ticked_by            uuid REFERENCES users(id),
  ticked_at            timestamptz NOT NULL DEFAULT now(),
  released_at          timestamptz,
  released_by          uuid REFERENCES users(id),
  release_reason       text,
  CONSTRAINT bank_reconciliation_items_one_owner CHECK (num_nonnulls(landlord_id, business_id) = 1),
  CONSTRAINT bank_reconciliation_items_source_check
    CHECK (source IN ('bank_line', 'ticked', 'opening', 'cancels_out')),
  CONSTRAINT bank_reconciliation_items_release_check
    CHECK ((released_at IS NULL) = (release_reason IS NULL)
           AND (release_reason IS NULL OR release_reason IN ('unticked', 'reconciliation_undone')))
);

-- A ledger line is cleared on one statement at most.
CREATE UNIQUE INDEX IF NOT EXISTS bank_reconciliation_items_line_once
  ON bank_reconciliation_items (ledger_line_id) WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS bank_reconciliation_items_reconciliation
  ON bank_reconciliation_items (reconciliation_id);
CREATE INDEX IF NOT EXISTS bank_reconciliation_items_account
  ON bank_reconciliation_items (account_id) WHERE released_at IS NULL;

COMMENT ON TABLE bank_reconciliation_items IS
  '10/12 (Nic, ledger P9): each ledger line cleared on a bank statement. Frozen once its reconciliation completes; released (kept) only by an untick while open or by undoing the reconciliation. BANK_RECONCILIATION_ITEM_SOURCES / _RELEASES.';

-- Items join only an open reconciliation, on its own account and company;
-- afterwards nothing about them changes but a release; none is deleted.
CREATE OR REPLACE FUNCTION bank_reconciliation_items_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  r record;
  l record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A cleared bank line is kept on record; untick it or undo the reconciliation.'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT status, account_id, landlord_id, business_id, statement_date INTO r
    FROM bank_reconciliations WHERE id = NEW.reconciliation_id;
  IF TG_OP = 'INSERT' THEN
    IF r.status IS DISTINCT FROM 'open' OR r.statement_date IS NULL THEN
      RAISE EXCEPTION 'Lines are cleared only on a statement still being reconciled.'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.released_at IS NOT NULL THEN
      RAISE EXCEPTION 'A cleared line starts cleared.' USING ERRCODE = 'check_violation';
    END IF;
    SELECT account_id, landlord_id, business_id INTO l FROM ledger_posting_lines WHERE id = NEW.ledger_line_id;
    IF l.account_id IS DISTINCT FROM r.account_id OR NEW.account_id IS DISTINCT FROM r.account_id
       OR l.landlord_id IS DISTINCT FROM r.landlord_id OR l.business_id IS DISTINCT FROM r.business_id
       OR NEW.landlord_id IS DISTINCT FROM r.landlord_id OR NEW.business_id IS DISTINCT FROM r.business_id THEN
      RAISE EXCEPTION 'That line is not on this bank account''s books.' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  -- UPDATE: only the release, once.
  IF OLD.released_at IS NOT NULL
     OR NEW.released_at IS NULL
     OR NEW.reconciliation_id IS DISTINCT FROM OLD.reconciliation_id
     OR NEW.landlord_id IS DISTINCT FROM OLD.landlord_id OR NEW.business_id IS DISTINCT FROM OLD.business_id
     OR NEW.account_id IS DISTINCT FROM OLD.account_id OR NEW.ledger_line_id IS DISTINCT FROM OLD.ledger_line_id
     OR NEW.amount IS DISTINCT FROM OLD.amount OR NEW.day IS DISTINCT FROM OLD.day
     OR NEW.bank_transaction_id IS DISTINCT FROM OLD.bank_transaction_id OR NEW.source IS DISTINCT FROM OLD.source
     OR NEW.ticked_by IS DISTINCT FROM OLD.ticked_by OR NEW.ticked_at IS DISTINCT FROM OLD.ticked_at THEN
    RAISE EXCEPTION 'A cleared bank line is frozen; it can only be let go.' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT ((r.status = 'open' AND NEW.release_reason = 'unticked')
          OR (r.status = 'undone' AND NEW.release_reason = 'reconciliation_undone')) THEN
    RAISE EXCEPTION 'A line cleared on a completed statement stays cleared unless the reconciliation is undone.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS bank_reconciliation_items_guard ON bank_reconciliation_items;
CREATE TRIGGER bank_reconciliation_items_guard
  BEFORE INSERT OR UPDATE OR DELETE ON bank_reconciliation_items
  FOR EACH ROW EXECUTE FUNCTION bank_reconciliation_items_guard();

-- The change journal (never pruned).
DROP TRIGGER IF EXISTS audit_bank_reconciliation_items ON bank_reconciliation_items;
CREATE TRIGGER audit_bank_reconciliation_items AFTER DELETE OR UPDATE ON bank_reconciliation_items
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();
