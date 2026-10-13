-- 10/12 (Nic) — GAM BOOKS LEDGER: THE POSTINGS, APPEND-ONLY AND BALANCED PER PROPERTY
--
-- Every money event posts its own balanced lines automatically, each line
-- tagged with its property, every line rebuildable from the source rows
-- (gam-ledger-design-2026-10-12 §1, §4 P3, §8, §9, §14). The engine
-- (services/ledgerEngine.postSource) writes them after the money transaction
-- has committed — never inside it — one short transaction per source.
--
--   ledger_rebuild_runs   one row per rebuild or nightly check: who, what,
--                         what it found (drift is kept here, never plugged).
--   ledger_postings       one posting per (source, posting kind, company).
--                         role 'post' is the posting as projected; when the
--                         source changes, the active post is SUPERSEDED: a
--                         'reversal' posting negates it line for line and a
--                         new 'post' carries the new lines. At most one active
--                         post per (source, kind, company) — a receipt that
--                         paid two companies' rows gets one per company.
--                         intended_date is the event's own day; accounting_date
--                         is where it lands (the first open day when that month
--                         is closed, or the day a fix was made when the company
--                         shows open-month fixes that way). fingerprint is a
--                         sha256 of the intended lines (dates, resolved
--                         accounts, dimensions, cents) — equal fingerprint, no
--                         new posting; rule_version is metadata only.
--   ledger_posting_lines  the lines. Each carries its company, both dates, the
--                         account and the posting role it was resolved from,
--                         the property (NULL = company level) and unit, lease,
--                         tenant, vendor, payment; report_category and
--                         cash_effect ('in' lines are Received, design §10).
--                         Exactly one of debit/credit is positive.
--
-- GUARANTEES, in the database:
--   - Append-only: lines are never changed or removed; a posting may only be
--     marked superseded, once. TRUNCATE is left for the test harness.
--   - Balanced: debits equal credits in every posting for every property
--     bucket (NULL included), checked when the transaction commits (a deferred
--     constraint trigger). A posting has at least two lines.
--   - A line belongs to a posting made in the same transaction, on the
--     posting's own company and accounting date, on an account of that
--     company's chart.
--   - Closed months: a line dated on or before the company's lock
--     (ledger_closed_through()) is refused. The engine moves such lines to the
--     first open day itself; this is the backstop. It takes the company's
--     shared ledger lock first, so it can never race a close (§13).
--
-- No foreign keys from lines to money rows (payments, leases, units...): a
-- books record must never stop a money row from being changed or removed.
--
-- Also here, now that the ledger tables exist: the chart guard on
-- books_accounts (the chart is fully editable, Nic 10/12, but an account the
-- automatic postings use cannot silently change type or vanish):
--   - its type cannot change once posted lines use it, or while the map points
--     at it;
--   - it cannot be turned off while the map points at it, and once posted
--     lines use it, only with a replacement named (retireAccount repoints the
--     map first);
--   - it cannot move to another company once the ledger or the map uses it;
--   - a replacement is an active account of the same company and type.
--
-- Values match LEDGER_SOURCE_TYPES, LEDGER_POSTING_KINDS, LEDGER_POSTING_ROLES,
-- LEDGER_CASH_EFFECTS, LEDGER_REPORT_CATEGORIES, LEDGER_MAP_KINDS,
-- LEDGER_RUN_MODES and LEDGER_RUN_STATUSES in packages/shared/src/booksLedger.ts.
--
-- The ledger is DARK: nothing posts in production until the projectors ship.
-- Expand-only. No backfill needed (new tables).
-- Safe drop: the three tables, their functions and the books_accounts guard.

SET LOCAL lock_timeout = '10s';

CREATE TABLE IF NOT EXISTS ledger_rebuild_runs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  landlord_id  uuid REFERENCES landlords(id),
  business_id  uuid REFERENCES businesses(id),
  mode         text NOT NULL,
  scope        jsonb NOT NULL DEFAULT '{}'::jsonb,
  status       text NOT NULL DEFAULT 'running',
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  started_by   uuid REFERENCES users(id),
  counts       jsonb NOT NULL DEFAULT '{}'::jsonb,
  drift        jsonb NOT NULL DEFAULT '[]'::jsonb,
  error        text,
  CONSTRAINT ledger_rebuild_runs_owner CHECK (num_nonnulls(landlord_id, business_id) <= 1),
  CONSTRAINT ledger_rebuild_runs_mode_check CHECK (mode IN ('dry_run', 'apply', 'from_scratch', 'check')),
  CONSTRAINT ledger_rebuild_runs_status_check CHECK (status IN ('running', 'done', 'failed', 'refused'))
);
CREATE INDEX IF NOT EXISTS ledger_rebuild_runs_landlord ON ledger_rebuild_runs (landlord_id, started_at DESC);
CREATE INDEX IF NOT EXISTS ledger_rebuild_runs_started ON ledger_rebuild_runs (started_at DESC);

COMMENT ON TABLE ledger_rebuild_runs IS
  '10/12 (Nic, ledger §8): every rebuild (dry_run, apply, from_scratch) and nightly check, with what it found. Drift is kept here and re-posted from source, never plugged.';

CREATE TABLE IF NOT EXISTS ledger_postings (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  landlord_id         uuid REFERENCES landlords(id),
  business_id         uuid REFERENCES businesses(id),
  source_type         text NOT NULL,
  source_id           text NOT NULL,
  posting_kind        text NOT NULL DEFAULT 'main',
  role                text NOT NULL,
  is_correction       boolean NOT NULL DEFAULT false,
  intended_date       date NOT NULL,
  accounting_date     date NOT NULL,
  fingerprint         text NOT NULL,
  rule_version        integer NOT NULL,
  reverses_posting_id uuid REFERENCES ledger_postings(id),
  superseded_at       timestamptz,
  superseded_by       uuid REFERENCES ledger_postings(id) DEFERRABLE INITIALLY DEFERRED,
  posted_at           timestamptz NOT NULL DEFAULT now(),
  posted_by           uuid REFERENCES users(id),
  rebuild_run_id      uuid REFERENCES ledger_rebuild_runs(id),
  memo                text,
  created_xid         xid8 NOT NULL DEFAULT pg_current_xact_id(),
  CONSTRAINT ledger_postings_one_owner CHECK (num_nonnulls(landlord_id, business_id) = 1),
  CONSTRAINT ledger_postings_source_type_check CHECK (source_type IN (
    'payment', 'remittance', 'prepaid_credit', 'credit_use', 'allocation', 'payment_reversal',
    'held_item', 'transfer_intent', 'disbursement', 'connect_payout', 'instant_margin',
    'gam_charge', 'gam_debit', 'reader_order',
    'pos_sale', 'pos_refund', 'pos_eod', 'pos_held', 'booking', 'refund_part',
    'security_deposit', 'deposit_return', 'home_sale', 'opening',
    'expense', 'expense_payment', 'other_income', 'deposit_slip', 'bank_match',
    'payroll_run', 'manual_journal', 'property_transfer', 'work_trade_hours')),
  CONSTRAINT ledger_postings_kind_check CHECK (posting_kind IN (
    'main', 'charge', 'prior_arrangement', 'gam_cover', 'work_trade', 'credit_spend')),
  CONSTRAINT ledger_postings_role_check CHECK (role IN ('post', 'reversal')),
  CONSTRAINT ledger_postings_reversal_names_original CHECK ((role = 'reversal') = (reverses_posting_id IS NOT NULL)),
  CONSTRAINT ledger_postings_reversal_never_superseded CHECK (role = 'post' OR superseded_at IS NULL),
  CONSTRAINT ledger_postings_superseded_has_time CHECK (superseded_by IS NULL OR superseded_at IS NOT NULL)
);

-- At most one active post per source, kind and company.
CREATE UNIQUE INDEX IF NOT EXISTS ledger_postings_one_active
  ON ledger_postings (source_type, source_id, posting_kind, (COALESCE(landlord_id, business_id)))
  WHERE role = 'post' AND superseded_at IS NULL;
CREATE INDEX IF NOT EXISTS ledger_postings_source ON ledger_postings (source_type, source_id);
CREATE INDEX IF NOT EXISTS ledger_postings_landlord_day ON ledger_postings (landlord_id, accounting_date) WHERE landlord_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ledger_postings_business_day ON ledger_postings (business_id, accounting_date) WHERE business_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ledger_postings_reverses ON ledger_postings (reverses_posting_id) WHERE reverses_posting_id IS NOT NULL;

COMMENT ON TABLE ledger_postings IS
  '10/12 (Nic, ledger §4 P3): one automatic posting per (source, kind, company). Append-only; a change supersedes it with a reversal and a new post.';

CREATE TABLE IF NOT EXISTS ledger_posting_lines (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  posting_id       uuid NOT NULL REFERENCES ledger_postings(id),
  line_no          smallint NOT NULL,
  landlord_id      uuid REFERENCES landlords(id),
  business_id      uuid REFERENCES businesses(id),
  accounting_date  date NOT NULL,
  intended_date    date NOT NULL,
  account_id       uuid NOT NULL REFERENCES books_accounts(id),
  account_role     text,
  map_kind         text,
  map_value        text,
  property_id      uuid,
  unit_id          uuid,
  lease_id         uuid,
  tenant_id        uuid,
  vendor_id        uuid,
  payment_id       uuid,
  report_category  text,
  -- The kind of money out an expense line is (P6, "money out is one record");
  -- its CHECK arrives with EXPENSE_KINDS in that phase.
  expense_kind     text,
  cash_effect      text,
  tax_name         text,
  debit            numeric(12,2) NOT NULL DEFAULT 0,
  credit           numeric(12,2) NOT NULL DEFAULT 0,
  memo             text,
  system_line      boolean NOT NULL DEFAULT false,
  CONSTRAINT ledger_posting_lines_one_owner CHECK (num_nonnulls(landlord_id, business_id) = 1),
  CONSTRAINT ledger_posting_lines_one_side CHECK (debit >= 0 AND credit >= 0 AND ((debit > 0) <> (credit > 0))),
  CONSTRAINT ledger_posting_lines_role_known CHECK (account_role IS NULL OR ledger_account_role_type(account_role) IS NOT NULL),
  CONSTRAINT ledger_posting_lines_map_kind_check CHECK (map_kind IS NULL OR map_kind IN ('role', 'bank_connection', 'sales_tax')),
  CONSTRAINT ledger_posting_lines_cash_effect_check CHECK (cash_effect IS NULL OR cash_effect IN ('in', 'out')),
  CONSTRAINT ledger_posting_lines_report_category_check CHECK (report_category IS NULL OR report_category IN (
    'space_rent', 'electric', 'water', 'sewer', 'gas', 'trash', 'propane', 'utility_other',
    'late_fees', 'home_payments', 'other_fees', 'balances_collected',
    'register_sales', 'stays_and_pay_links', 'other_income',
    'paid_ahead', 'deposits', 'tax_collected', 'not_income', 'credits_given', 'work_trade', 'refunds', 'opening',
    'maintenance', 'repairs', 'utilities', 'insurance', 'property_tax', 'management',
    'supplies', 'landscaping', 'professional', 'mortgage_interest', 'hoa', 'advertising',
    'lot_rent', 'bank_fees', 'other'))
);

CREATE INDEX IF NOT EXISTS ledger_posting_lines_posting ON ledger_posting_lines (posting_id);
CREATE INDEX IF NOT EXISTS ledger_posting_lines_account ON ledger_posting_lines (account_id);
CREATE INDEX IF NOT EXISTS ledger_posting_lines_landlord_account_day
  ON ledger_posting_lines (landlord_id, account_id, accounting_date) WHERE landlord_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ledger_posting_lines_landlord_property_day
  ON ledger_posting_lines (landlord_id, property_id, accounting_date) WHERE landlord_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ledger_posting_lines_landlord_tenant_ar
  ON ledger_posting_lines (landlord_id, tenant_id) WHERE account_role = 'ar_tenants';
CREATE INDEX IF NOT EXISTS ledger_posting_lines_landlord_cash_day
  ON ledger_posting_lines (landlord_id, cash_effect, accounting_date) WHERE cash_effect IS NOT NULL;
CREATE INDEX IF NOT EXISTS ledger_posting_lines_business_account_day
  ON ledger_posting_lines (business_id, account_id, accounting_date) WHERE business_id IS NOT NULL;

COMMENT ON TABLE ledger_posting_lines IS
  '10/12 (Nic, ledger §4 P3): the lines of each automatic posting, tagged by property. Append-only; balanced per posting per property.';

-- ── The shared ledger lock key (services/ledgerEngine ownerLockKey) ──────────
CREATE OR REPLACE FUNCTION ledger_owner_lock_key(p_landlord uuid, p_business uuid) RETURNS bigint
LANGUAGE sql IMMUTABLE AS $$
  SELECT hashtextextended('ledger_owner:' || COALESCE(p_landlord, p_business)::text, 0)
$$;

-- ── Postings: only "superseded", once ───────────────────────────────────────
CREATE OR REPLACE FUNCTION ledger_postings_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A ledger posting is never removed; a change is posted as a reversal and a new posting.'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.superseded_at IS NOT NULL THEN
    RAISE EXCEPTION 'Ledger posting % was already superseded.', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.superseded_at IS NULL
     OR (to_jsonb(NEW) - 'superseded_at' - 'superseded_by') IS DISTINCT FROM (to_jsonb(OLD) - 'superseded_at' - 'superseded_by') THEN
    RAISE EXCEPTION 'A ledger posting is never changed; it may only be marked superseded, once.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS ledger_postings_guard ON ledger_postings;
CREATE TRIGGER ledger_postings_guard
  BEFORE UPDATE OR DELETE ON ledger_postings
  FOR EACH ROW EXECUTE FUNCTION ledger_postings_guard();

-- ── Lines: never changed; written with their posting; never in a closed month ─
CREATE OR REPLACE FUNCTION ledger_posting_lines_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  p          record;
  acct       record;
  locked_to  date;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'A ledger line is never changed or removed; a change is posted as a reversal and a new posting (%).', TG_OP
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT lp.landlord_id, lp.business_id, lp.accounting_date, lp.intended_date, lp.created_xid INTO p
    FROM ledger_postings lp WHERE lp.id = NEW.posting_id;
  IF p.created_xid IS DISTINCT FROM pg_current_xact_id() THEN
    RAISE EXCEPTION 'Ledger lines are written with their posting, in the same transaction.'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.landlord_id IS DISTINCT FROM p.landlord_id OR NEW.business_id IS DISTINCT FROM p.business_id
     OR NEW.accounting_date IS DISTINCT FROM p.accounting_date OR NEW.intended_date IS DISTINCT FROM p.intended_date THEN
    RAISE EXCEPTION 'A ledger line carries its posting''s company and dates.' USING ERRCODE = 'check_violation';
  END IF;
  SELECT a.landlord_id, a.business_id INTO acct FROM books_accounts a WHERE a.id = NEW.account_id;
  IF acct.landlord_id IS DISTINCT FROM NEW.landlord_id OR acct.business_id IS DISTINCT FROM NEW.business_id THEN
    RAISE EXCEPTION 'A ledger line posts to its own company''s chart.' USING ERRCODE = 'check_violation';
  END IF;
  -- The close takes this lock exclusively; holding it shared means the lock
  -- date read below cannot change before this transaction commits.
  PERFORM pg_advisory_xact_lock_shared(ledger_owner_lock_key(NEW.landlord_id, NEW.business_id));
  locked_to := ledger_closed_through(NEW.landlord_id, NEW.business_id);
  IF locked_to IS NOT NULL AND NEW.accounting_date <= locked_to THEN
    RAISE EXCEPTION 'The books are closed through %; this line belongs on the first open day.', locked_to
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS ledger_posting_lines_guard ON ledger_posting_lines;
CREATE TRIGGER ledger_posting_lines_guard
  BEFORE INSERT OR UPDATE OR DELETE ON ledger_posting_lines
  FOR EACH ROW EXECUTE FUNCTION ledger_posting_lines_guard();

-- ── Balanced per posting, per property bucket, checked at commit ─────────────
CREATE OR REPLACE FUNCTION ledger_postings_balanced() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  n_lines  integer;
  off      record;
BEGIN
  SELECT count(*) INTO n_lines FROM ledger_posting_lines WHERE posting_id = NEW.id;
  IF n_lines < 2 THEN
    RAISE EXCEPTION 'Ledger posting % (% %) has % line(s); a posting has at least two.', NEW.id, NEW.source_type, NEW.source_id, n_lines
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT l.property_id, sum(l.debit) AS dr, sum(l.credit) AS cr INTO off
    FROM ledger_posting_lines l
   WHERE l.posting_id = NEW.id
   GROUP BY l.property_id
  HAVING sum(l.debit) <> sum(l.credit)
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'Ledger posting % (% %) does not balance for property %: debits % vs credits %.',
      NEW.id, NEW.source_type, NEW.source_id, COALESCE(off.property_id::text, '(company)'), off.dr, off.cr
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS ledger_postings_balanced ON ledger_postings;
CREATE CONSTRAINT TRIGGER ledger_postings_balanced
  AFTER INSERT ON ledger_postings
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_postings_balanced();

-- ── The chart guard (see header) ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION books_accounts_ledger_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  has_lines  boolean;
  is_mapped  boolean;
  ever_mapped boolean;
  repl       record;
BEGIN
  IF NEW.type IS NOT DISTINCT FROM OLD.type
     AND NEW.active IS NOT DISTINCT FROM OLD.active
     AND NEW.landlord_id IS NOT DISTINCT FROM OLD.landlord_id
     AND NEW.business_id IS NOT DISTINCT FROM OLD.business_id
     AND NEW.replaced_by_account_id IS NOT DISTINCT FROM OLD.replaced_by_account_id THEN
    RETURN NEW;
  END IF;

  has_lines := EXISTS (SELECT 1 FROM ledger_posting_lines l WHERE l.account_id = OLD.id);
  ever_mapped := EXISTS (SELECT 1 FROM books_account_map m WHERE m.account_id = OLD.id);
  -- "Mapped" = the row in force today for some (kind, value) of this company
  -- points here (the latest row; a repoint is never dated in the future).
  is_mapped := ever_mapped AND EXISTS (
    SELECT 1 FROM (
      SELECT DISTINCT ON (m.map_kind, m.map_value) m.account_id
        FROM books_account_map m
       WHERE (OLD.landlord_id IS NOT NULL AND m.landlord_id = OLD.landlord_id)
          OR (OLD.business_id IS NOT NULL AND m.business_id = OLD.business_id)
       ORDER BY m.map_kind, m.map_value, m.effective_from DESC, m.id DESC
    ) cur WHERE cur.account_id = OLD.id);

  IF NEW.type IS DISTINCT FROM OLD.type AND (has_lines OR is_mapped) THEN
    RAISE EXCEPTION '% already carries automatic postings, so its type cannot change. Add a new account of the right type and point the posting role at it.', OLD.name
      USING ERRCODE = 'check_violation';
  END IF;

  IF (NEW.landlord_id IS DISTINCT FROM OLD.landlord_id OR NEW.business_id IS DISTINCT FROM OLD.business_id)
     AND (has_lines OR ever_mapped) THEN
    RAISE EXCEPTION '% belongs to its company''s books and cannot move to another company.', OLD.name
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.replaced_by_account_id IS NOT NULL THEN
    IF NEW.replaced_by_account_id = NEW.id THEN
      RAISE EXCEPTION 'An account cannot replace itself.' USING ERRCODE = 'check_violation';
    END IF;
    SELECT a.landlord_id, a.business_id, a.type, a.active, a.name INTO repl
      FROM books_accounts a WHERE a.id = NEW.replaced_by_account_id;
    IF repl.landlord_id IS DISTINCT FROM NEW.landlord_id OR repl.business_id IS DISTINCT FROM NEW.business_id
       OR repl.type IS DISTINCT FROM NEW.type OR repl.active IS NOT TRUE THEN
      RAISE EXCEPTION 'The replacement must be an active % account in the same chart.', NEW.type
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF OLD.active IS NOT FALSE AND NEW.active IS FALSE THEN
    IF is_mapped THEN
      RAISE EXCEPTION '% is where automatic postings go. Choose the account that takes its place, then delete it.', OLD.name
        USING ERRCODE = 'check_violation';
    END IF;
    IF has_lines AND NEW.replaced_by_account_id IS NULL THEN
      RAISE EXCEPTION '% has posted history. Choose the account that takes its place, then delete it.', OLD.name
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS books_accounts_ledger_guard ON books_accounts;
CREATE TRIGGER books_accounts_ledger_guard
  BEFORE UPDATE ON books_accounts
  FOR EACH ROW EXECUTE FUNCTION books_accounts_ledger_guard();
