-- 10/12 (Nic) — GAM BOOKS LEDGER: A FULLY EDITABLE CHART, AND THE MAP THAT
-- TELLS AUTOMATIC POSTINGS WHERE TO GO
--
-- Nic, 10/12: the chart of accounts is FULLY EDITABLE — landlords and
-- bookkeepers may rename, add and delete accounts. So automatic postings never
-- name an account. Each automatic line names a POSTING ROLE ("tenant
-- receivables", "late fees", "money GAM holds for you"), and the company's map
-- says which account that role posts to (gam-ledger-design-2026-10-12 §5,
-- adapted to the editable chart):
--
--   books_account_map   one row per (company, map_kind, map_value) and the day
--                       it took effect. map_kind 'role' maps a posting role
--                       (LEDGER_ACCOUNT_ROLES); 'bank_connection' maps one
--                       linked bank to its own sub-account under Checking;
--                       'sales_tax' maps one named tax to its own sub-account
--                       under Sales tax payable (LEDGER_MAP_KINDS).
--
--   GAM SEEDS the map the first time a company posts (services/
--   booksLedgerChart.ensureChart): it reuses an account the company already
--   has at the suggested code and type, or adds one; first rows are dated
--   1900-01-01 ("from the beginning").
--
--   The company may REPOINT a role to another account of the same type. A
--   repoint is a NEW row dated the day it is made — never inside a closed
--   month — so it applies to postings dated from that day on. Rows are never
--   changed or removed: a posting is always resolved through the row in effect
--   on its own date, so history stays on the account it was posted to and a
--   rebuild comes out the same.
--
-- DELETING an account the map or posted lines use requires choosing a
-- replacement (Nic): the account is never removed and its posted lines are
-- never changed — it is retired (active = false) with replaced_by_account_id
-- naming the replacement, and every map row pointing at it is repointed to the
-- replacement first (services/booksLedgerChart.retireAccount). The database
-- guard on books_accounts (20261013200300, once the ledger tables exist)
-- refuses a deactivation that would leave the map pointing at a retired
-- account, or posted lines with no replacement.
--
-- books_accounts gains:
--   parent_account_id       the account this one sits under (utility and payroll
--                           sub-accounts, one sub-account per bank or tax)
--   bank_connection_id      the linked bank a Checking sub-account stands for
--   replaced_by_account_id  a retired account's replacement (same company, same type)
--   retired_at, retired_by  when and by whom it was retired
-- and its company foreign keys move from ON DELETE CASCADE to RESTRICT: an
-- account that carries posted history is never erased with its company
-- (keep-everything; production never deletes a company).
--
-- ledger_account_role_type(role) / ledger_account_role_is_control(role) are
-- the posting-role catalog in SQL; services/ledgerCoverage.test.ts holds them
-- equal to LEDGER_ACCOUNT_ROLE_DEFS in packages/shared/src/booksLedger.ts.
--
-- The ledger is DARK: nothing seeds or reads the map until the engine posts.
-- Expand-only. Production had 0 accounts on 10/12 (read-only count).
-- No backfill needed.
-- Safe drop: books_account_map, the two functions, the new columns; restore
-- ON DELETE CASCADE on books_accounts_landlord_id_fkey / _business_id_fkey.

SET LOCAL lock_timeout = '10s';

-- ── The posting-role catalog ────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION ledger_account_role_type(p_role text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_role
    WHEN 'bank_checking' THEN 'asset'
    WHEN 'bank_savings' THEN 'asset'
    WHEN 'own_deposit_account' THEN 'asset'
    WHEN 'undeposited_funds' THEN 'asset'
    WHEN 'deposits_in_transit' THEN 'asset'
    WHEN 'due_from_gam' THEN 'asset'
    WHEN 'due_from_gam_tenant_money' THEN 'asset'
    WHEN 'stripe_in_transit' THEN 'asset'
    WHEN 'deposits_gam_holds' THEN 'asset'
    WHEN 'suspense' THEN 'asset'
    WHEN 'ar_tenants' THEN 'asset'
    WHEN 'ar_store_accounts' THEN 'asset'
    WHEN 'prepaid_expenses' THEN 'asset'
    WHEN 'inventory' THEN 'asset'
    WHEN 'home_notes_receivable' THEN 'asset'
    WHEN 'rental_property' THEN 'asset'
    WHEN 'accumulated_depreciation' THEN 'asset'
    WHEN 'homes_held_for_sale' THEN 'asset'
    WHEN 'equipment' THEN 'asset'
    WHEN 'accounts_payable' THEN 'liability'
    WHEN 'outstanding_checks' THEN 'liability'
    WHEN 'security_deposits_payable' THEN 'liability'
    WHEN 'payroll_liabilities' THEN 'liability'
    WHEN 'payroll_federal_withholding' THEN 'liability'
    WHEN 'payroll_state_withholding' THEN 'liability'
    WHEN 'payroll_fica' THEN 'liability'
    WHEN 'net_pay_payable' THEN 'liability'
    WHEN 'sales_tax_payable' THEN 'liability'
    WHEN 'lodging_tax_payable' THEN 'liability'
    WHEN 'utility_tax_payable' THEN 'liability'
    WHEN 'tenant_prepayments' THEN 'liability'
    WHEN 'guest_deposits' THEN 'liability'
    WHEN 'due_to_gam' THEN 'liability'
    WHEN 'equipment_owed_to_gam' THEN 'liability'
    WHEN 'mortgage_payable' THEN 'liability'
    WHEN 'credit_card_payable' THEN 'liability'
    WHEN 'owner_equity' THEN 'equity'
    WHEN 'owner_draws' THEN 'equity'
    WHEN 'retained_earnings' THEN 'equity'
    WHEN 'opening_balance_equity' THEN 'equity'
    WHEN 'interproperty_clearing' THEN 'equity'
    WHEN 'space_rent' THEN 'income'
    WHEN 'late_fees' THEN 'income'
    WHEN 'application_fees' THEN 'income'
    WHEN 'pet_fees' THEN 'income'
    WHEN 'laundry_vending' THEN 'income'
    WHEN 'storage_fees' THEN 'income'
    WHEN 'utility_reimbursements' THEN 'income'
    WHEN 'utility_electric' THEN 'income'
    WHEN 'utility_water' THEN 'income'
    WHEN 'utility_sewer' THEN 'income'
    WHEN 'utility_gas' THEN 'income'
    WHEN 'utility_trash' THEN 'income'
    WHEN 'utility_propane' THEN 'income'
    WHEN 'utility_other' THEN 'income'
    WHEN 'other_fees' THEN 'income'
    WHEN 'credits_given' THEN 'income'
    WHEN 'work_trade_discount' THEN 'income'
    WHEN 'home_sales' THEN 'income'
    WHEN 'home_note_interest' THEN 'income'
    WHEN 'stay_income' THEN 'income'
    WHEN 'register_sales' THEN 'income'
    WHEN 'sales_returns' THEN 'income'
    WHEN 'deposit_deductions_kept' THEN 'income'
    WHEN 'other_income' THEN 'income'
    WHEN 'interest_earned' THEN 'income'
    WHEN 'mortgage_interest' THEN 'expense'
    WHEN 'property_taxes' THEN 'expense'
    WHEN 'insurance' THEN 'expense'
    WHEN 'repairs_maintenance' THEN 'expense'
    WHEN 'utilities_expense' THEN 'expense'
    WHEN 'landscaping' THEN 'expense'
    WHEN 'pest_control' THEN 'expense'
    WHEN 'management_fees' THEN 'expense'
    WHEN 'advertising' THEN 'expense'
    WHEN 'professional_fees' THEN 'expense'
    WHEN 'accounting_fees' THEN 'expense'
    WHEN 'processing_fees' THEN 'expense'
    WHEN 'chargeback_fees' THEN 'expense'
    WHEN 'payroll_expense' THEN 'expense'
    WHEN 'employer_payroll_taxes' THEN 'expense'
    WHEN 'contractor_payments' THEN 'expense'
    WHEN 'supplies' THEN 'expense'
    WHEN 'software_subscriptions' THEN 'expense'
    WHEN 'gam_platform_fees' THEN 'expense'
    WHEN 'vehicle_travel' THEN 'expense'
    WHEN 'depreciation_expense' THEN 'expense'
    WHEN 'bad_debt' THEN 'expense'
    WHEN 'work_trade_labor' THEN 'expense'
    WHEN 'cash_over_short' THEN 'expense'
    WHEN 'lot_rent_expense' THEN 'expense'
    WHEN 'hoa_fees' THEN 'expense'
    WHEN 'bank_fees' THEN 'expense'
    WHEN 'cost_of_goods_sold' THEN 'expense'
    WHEN 'cost_of_homes_sold' THEN 'expense'
    WHEN 'other_expenses' THEN 'expense'
    ELSE NULL END
$$;

CREATE OR REPLACE FUNCTION ledger_account_role_is_control(p_role text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT p_role IN ('undeposited_funds', 'deposits_in_transit', 'due_from_gam', 'due_from_gam_tenant_money',
                    'stripe_in_transit', 'deposits_gam_holds', 'ar_tenants', 'ar_store_accounts',
                    'home_notes_receivable', 'accounts_payable', 'outstanding_checks', 'security_deposits_payable',
                    'tenant_prepayments', 'guest_deposits', 'due_to_gam', 'equipment_owed_to_gam',
                    'interproperty_clearing')
$$;

-- ── books_accounts: sub-accounts, retirement, and a company never cascades ──

ALTER TABLE books_accounts
  ADD COLUMN IF NOT EXISTS parent_account_id      uuid REFERENCES books_accounts(id),
  ADD COLUMN IF NOT EXISTS bank_connection_id     uuid REFERENCES bank_connections(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS replaced_by_account_id uuid REFERENCES books_accounts(id),
  ADD COLUMN IF NOT EXISTS retired_at             timestamptz,
  ADD COLUMN IF NOT EXISTS retired_by             uuid REFERENCES users(id);

ALTER TABLE books_accounts DROP CONSTRAINT IF EXISTS books_accounts_landlord_id_fkey;
ALTER TABLE books_accounts
  ADD CONSTRAINT books_accounts_landlord_id_fkey FOREIGN KEY (landlord_id) REFERENCES landlords(id) NOT VALID;
ALTER TABLE books_accounts VALIDATE CONSTRAINT books_accounts_landlord_id_fkey;

ALTER TABLE books_accounts DROP CONSTRAINT IF EXISTS books_accounts_business_id_fkey;
ALTER TABLE books_accounts
  ADD CONSTRAINT books_accounts_business_id_fkey FOREIGN KEY (business_id) REFERENCES businesses(id) NOT VALID;
ALTER TABLE books_accounts VALIDATE CONSTRAINT books_accounts_business_id_fkey;

CREATE INDEX IF NOT EXISTS books_accounts_parent ON books_accounts (parent_account_id) WHERE parent_account_id IS NOT NULL;

COMMENT ON COLUMN books_accounts.replaced_by_account_id IS
  '10/12 (Nic): a retired account''s replacement. Its posted lines stay where they are; the map and new postings use the replacement.';

-- ── The map ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS books_account_map (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  landlord_id     uuid REFERENCES landlords(id),
  business_id     uuid REFERENCES businesses(id),
  map_kind        text NOT NULL,
  map_value       text NOT NULL,
  account_id      uuid NOT NULL REFERENCES books_accounts(id),
  effective_from  date NOT NULL,
  set_by          uuid REFERENCES users(id),
  set_at          timestamptz NOT NULL DEFAULT now(),
  note            text,
  CONSTRAINT books_account_map_one_owner CHECK (num_nonnulls(landlord_id, business_id) = 1),
  CONSTRAINT books_account_map_kind_check CHECK (map_kind IN ('role', 'bank_connection', 'sales_tax')),
  CONSTRAINT books_account_map_role_known CHECK (map_kind <> 'role' OR ledger_account_role_type(map_value) IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS books_account_map_landlord
  ON books_account_map (landlord_id, map_kind, map_value, effective_from DESC, id DESC) WHERE landlord_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS books_account_map_business
  ON books_account_map (business_id, map_kind, map_value, effective_from DESC, id DESC) WHERE business_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS books_account_map_account ON books_account_map (account_id);

COMMENT ON TABLE books_account_map IS
  '10/12 (Nic, ledger §5): which account each posting role (or bank, or named tax) posts to, from which day. Append-only; a repoint is a new row dated the day it is made.';

-- A map row points at an active account of the same company, of the type its
-- role needs, and a repoint is never dated inside a closed month.
CREATE OR REPLACE FUNCTION books_account_map_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  acct      record;
  expected  text;
  locked_to date;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'books_account_map is the history of where each posting role went; a repoint is a new row, never a change (%).', TG_OP
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT a.landlord_id, a.business_id, a.type, a.active, a.name INTO acct
    FROM books_accounts a WHERE a.id = NEW.account_id;
  IF acct.landlord_id IS DISTINCT FROM NEW.landlord_id OR acct.business_id IS DISTINCT FROM NEW.business_id THEN
    RAISE EXCEPTION 'That account belongs to another company''s chart.' USING ERRCODE = 'check_violation';
  END IF;
  IF acct.active IS FALSE THEN
    RAISE EXCEPTION '% is retired. Choose an active account.', acct.name USING ERRCODE = 'check_violation';
  END IF;
  expected := CASE NEW.map_kind
                WHEN 'role' THEN ledger_account_role_type(NEW.map_value)
                WHEN 'bank_connection' THEN 'asset'
                WHEN 'sales_tax' THEN 'liability'
              END;
  IF expected IS NULL THEN
    RAISE EXCEPTION '% is not a posting role the books use.', NEW.map_value USING ERRCODE = 'check_violation';
  END IF;
  IF acct.type IS DISTINCT FROM expected THEN
    RAISE EXCEPTION '% is an % account; this needs an % account.', acct.name, acct.type, expected
      USING ERRCODE = 'check_violation';
  END IF;
  -- The first row for a role may cover all history; a repoint never reaches
  -- into a closed month.
  IF EXISTS (SELECT 1 FROM books_account_map m
              WHERE m.map_kind = NEW.map_kind AND m.map_value = NEW.map_value
                AND ((NEW.landlord_id IS NOT NULL AND m.landlord_id = NEW.landlord_id)
                     OR (NEW.business_id IS NOT NULL AND m.business_id = NEW.business_id))) THEN
    locked_to := ledger_closed_through(NEW.landlord_id, NEW.business_id);
    IF locked_to IS NOT NULL AND NEW.effective_from <= locked_to THEN
      RAISE EXCEPTION 'The books are closed through %; a repoint takes effect after that.', locked_to
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS books_account_map_guard ON books_account_map;
CREATE TRIGGER books_account_map_guard
  BEFORE INSERT OR UPDATE OR DELETE ON books_account_map
  FOR EACH ROW EXECUTE FUNCTION books_account_map_guard();
