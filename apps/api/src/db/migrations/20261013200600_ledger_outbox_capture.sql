-- 10/12 (Nic) — GAM BOOKS LEDGER: EVERY MONEY CHANGE MARKS ITS SOURCE FOR POSTING
--
-- Nic, 10/12 (L1): the books are posted within about a minute of the money
-- event, plus a nightly tie-out. Posting happens AFTER the money transaction
-- commits, never inside it (gam-ledger-design-2026-10-12 §3, §7). The only
-- piece that runs inside a money write is this capture: each money table has
-- three STATEMENT-level AFTER triggers (INSERT, UPDATE, DELETE) that read the
-- statement's transition tables and append one row per changed source to
--
--   ledger_outbox  (source_type, source_id, owner_id, xid, at)
--
-- which the engine drains every minute (services/ledgerEngine.drainLedgerOutbox,
-- one short transaction per source, deleting exactly the outbox ids it read).
--
-- A MONEY WRITE IS NEVER BLOCKED, SLOWED OR FAILED BY THE BOOKS:
--   - One INSERT … SELECT DISTINCT per statement, not per row. A bulk UPDATE
--     touches the outbox once.
--   - An UPDATE is captured only when a column the ledger reads changed (the
--     list per table is LEDGER_CAPTURE_COLUMNS in packages/shared). The
--     column filter is in the body because PostgreSQL does not allow a column
--     list (UPDATE OF) on a trigger with transition tables. So the weekly
--     "UPDATE payments SET platform_held = false" over every settled row, retry
--     timers, sync stamps and notes write nothing at all. (The filter compares
--     named columns, ROW(o.col::text, …): 10/12 (Nic) review — a jsonb
--     projection that would survive a dropped column measured ~4x slower on a
--     10,000-row update, so the DDL guard below protects the names instead.)
--   - Writers only INSERT new outbox rows. The outbox has no unique key, no
--     foreign key and no CHECK, so the insert cannot conflict, wait on another
--     transaction or fail short of the database itself failing. The drain
--     deletes only rows that were committed before it read them; nothing a
--     writer does waits on the drain, and no row lock is shared.
--   - No EXCEPTION block in any capture body (each one would open a
--     subtransaction per statement and slow every session's snapshots on bulk
--     writes).
--   - Every trigger is compiled and run once by this migration (an UPDATE /
--     DELETE / INSERT matching no row still fires a statement trigger), so a
--     mistake in one fails here, at deploy — never in a money write.
--
-- A LATER SCHEMA CHANGE CAN NEVER BREAK A CAPTURE BODY UNNOTICED (10/12 (Nic)
-- review). PostgreSQL records no dependency for a name inside a PL/pgSQL body:
-- a migration that dropped or renamed a column a body names (payments.voided_at,
-- remittance_applications.payment_id, …) or a table it reads would succeed, and
-- from then on every write to that money table would fail. So:
--   - ledger_check_capture() checks every capture table: each column its
--     "-- ledger columns:" list names still exists, and its three bodies still
--     compile and run (the same no-op INSERT / UPDATE / DELETE as above);
--   - the event trigger ledger_ddl_guard (ddl_command_end, ALTER TABLE and
--     DROP TABLE) refuses, inside that migration, a drop or rename of any
--     table a capture body reads, and runs ledger_check_capture() whenever a
--     table a body reads is altered. Breaking DDL fails in its own migration,
--     never in a money write. (An event trigger needs a superuser, which the
--     API's database role is; without one the migration says so in a NOTICE
--     and services/ledgerCoverage.test.ts still holds every listed column to
--     its table.)
-- Columns a capture body reads are dropped or renamed only expand-then-
-- contract: the contract migration first re-installs the table's capture
-- without the column (ledger_install_capture with the new list, and the new
-- LEDGER_CAPTURE_COLUMNS), then drops it. A column on the list that a table
-- does not have yet (a lane that has not shipped) is left out with a NOTICE;
-- services/ledgerCoverage.test.ts holds every trigger to the shared list.
--
-- RE-INSTALLING never takes a table lock beyond what a write takes (10/12 (Nic)
-- review): ledger_install_capture() replaces the three bodies (CREATE OR
-- REPLACE FUNCTION, no table lock) and creates a trigger only when it is
-- missing or different. A later phase widens a table's list by calling it again
-- from its own migration; that never blocks a read of a money table.
--
-- ledger_source_errors: a source that could not post (the engine's projector
-- refused or threw) keeps its outbox rows and gets a row here with the reason,
-- the attempts and when to try again; an admin notice fires after 3 failures.
--
-- landlords.books_start_date keeps one ROW-level trigger (a column list cannot
-- be combined with transition tables, and the change is rare). It marks the
-- company's opening posting ('opening'), and — when the date MOVES, not when
-- it is first picked — a 'books_start' mark naming the days between the old
-- and new date (source_id 'landlord id|from|to', to exclusive). The engine
-- turns that mark into every source of the company dated in those days (10/12
-- (Nic) review): a later start takes back what now opens in the opening
-- posting, an earlier start posts what was held back.
--
-- Values match LEDGER_SOURCE_TYPES, LEDGER_OUTBOX_BOOKS_START and
-- LEDGER_SOURCE_ERROR_REASONS in packages/shared/src/booksLedger.ts.
--
-- DARK: production has no projectors yet, so the outbox fills and nothing
-- posts until the projector phases ship (their first rebuild runs from scratch
-- anyway; the outbox rows they find are harmless re-checks).
--
-- LOCKS (10/12 (Nic) review). CREATE TRIGGER takes a SHARE ROW EXCLUSIVE lock
-- on its table until this migration commits. Installing table by table would
-- hold the early tables' locks while waiting for later ones: writers to those
-- tables queue for the whole migration, a settle that writes two of them can
-- deadlock with it, and a lock request waiting behind an older transaction
-- makes every new payment write queue behind the request. Instead, every table
-- this migration triggers (each capture table and landlords) is locked up
-- front in ONE statement with NOWAIT, retried for up to ~30 seconds, and never
-- waited on: while it retries this migration holds no lock and queues no lock
-- request, so no writer ever waits on it and no deadlock can form. Once it has
-- them all, the installs run (about a tenth of a second measured for all 46
-- tables) and money writes resume when it commits. If the money tables never
-- go quiet for an instant, it fails and runs again at the next start. The settle and payout
-- path's tables are still installed last, payments the very last. lock_timeout
-- (2 s) bounds anything else it reads (the tables a capture body selects from),
-- and this session's deadlock_timeout is set far below every other session's,
-- so in any deadlock it is THIS migration that gives up, never a money write.
--
-- Expand-only. No backfill needed: a projector phase's first rebuild reads the
-- source rows themselves.
-- Safe drop: the event trigger ledger_ddl_guard and ledger_ddl_guard(),
-- ledger_check_capture(), the ledger_capture_* triggers and functions on every
-- table below, ledger_install_capture(), ledger_capture_books_start(),
-- ledger_outbox, ledger_source_errors.

SET LOCAL lock_timeout = '2s';
DO $$
BEGIN
  PERFORM set_config('deadlock_timeout', '100ms', true);
EXCEPTION WHEN insufficient_privilege THEN
  NULL;  -- not a superuser: keep the server default
END $$;

CREATE TABLE IF NOT EXISTS ledger_outbox (
  id           bigserial,
  source_type  text NOT NULL,
  source_id    text NOT NULL,
  owner_id     uuid,
  xid          xid8 NOT NULL DEFAULT pg_current_xact_id(),
  at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ledger_outbox_id ON ledger_outbox (id);
CREATE INDEX IF NOT EXISTS ledger_outbox_source ON ledger_outbox (source_type, source_id);
CREATE INDEX IF NOT EXISTS ledger_outbox_owner ON ledger_outbox (owner_id);
CREATE INDEX IF NOT EXISTS ledger_outbox_xid ON ledger_outbox (xid);

COMMENT ON TABLE ledger_outbox IS
  '10/12 (Nic, ledger §3/§7): sources whose money changed and that the engine has not posted yet. Insert-only for writers; no keys, no checks, so a money write can never wait on or fail because of it.';

CREATE TABLE IF NOT EXISTS ledger_source_errors (
  source_type      text NOT NULL,
  source_id        text NOT NULL,
  owner_id         uuid,
  reason_code      text NOT NULL,
  attempts         integer NOT NULL DEFAULT 1,
  last_error       text NOT NULL,
  first_failed_at  timestamptz NOT NULL DEFAULT now(),
  last_failed_at   timestamptz NOT NULL DEFAULT now(),
  next_try_at      timestamptz NOT NULL,
  noticed_at       timestamptz,
  PRIMARY KEY (source_type, source_id),
  CONSTRAINT ledger_source_errors_reason_check CHECK (reason_code IN (
    'projector_error', 'post_error', 'unbalanced', 'no_books_start', 'owner_not_ready', 'missing_fact'))
);
CREATE INDEX IF NOT EXISTS ledger_source_errors_owner ON ledger_source_errors (owner_id);

COMMENT ON TABLE ledger_source_errors IS
  '10/12 (Nic, ledger §3): a source that could not post — its outbox rows stay; this says why, how many tries, and when to try again.';

-- ── The installer: three statement triggers per table, generated ────────────
CREATE OR REPLACE FUNCTION ledger_install_capture(p_table text, p_columns text[], p_keys text) RETURNS void
LANGUAGE plpgsql AS $inst$
DECLARE
  cols     text[];
  missing  text[];
  o_list   text;
  n_list   text;
  col_note text;
  rel      regclass;
  ev       record;
  fn       regprocedure;
BEGIN
  rel := to_regclass('public.' || quote_ident(p_table));
  IF rel IS NULL THEN
    RAISE NOTICE 'ledger capture: table % does not exist yet; nothing installed', p_table;
    RETURN;
  END IF;
  SELECT array_agg(u.c ORDER BY u.ord) FILTER (WHERE ic.column_name IS NOT NULL),
         array_agg(u.c ORDER BY u.ord) FILTER (WHERE ic.column_name IS NULL)
    INTO cols, missing
    FROM unnest(p_columns) WITH ORDINALITY AS u(c, ord)
    LEFT JOIN information_schema.columns ic
      ON ic.table_schema = 'public' AND ic.table_name = p_table AND ic.column_name = u.c;
  IF missing IS NOT NULL THEN
    RAISE NOTICE 'ledger capture: % has no column(s) %; captured without them', p_table, missing;
  END IF;
  IF cols IS NULL THEN
    RAISE EXCEPTION 'ledger capture: % has none of the columns the ledger reads', p_table;
  END IF;
  SELECT string_agg(format('o.%I::text', c), ', ' ORDER BY ord),
         string_agg(format('n.%I::text', c), ', ' ORDER BY ord)
    INTO o_list, n_list
    FROM unnest(cols) WITH ORDINALITY AS u(c, ord);
  col_note := array_to_string(cols, ',');

  EXECUTE format($f$
CREATE OR REPLACE FUNCTION %I() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
  -- ledger columns: %s
  INSERT INTO ledger_outbox (source_type, source_id, owner_id)
  SELECT DISTINCT k.source_type, k.source_id, k.owner_id
    FROM ledger_new r
    CROSS JOIN LATERAL (%s) k(source_type, source_id, owner_id)
   WHERE k.source_id IS NOT NULL;
  RETURN NULL;
END $body$$f$, 'ledger_capture_' || p_table || '_ins', col_note, p_keys);

  EXECUTE format($f$
CREATE OR REPLACE FUNCTION %I() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
  -- ledger columns: %s
  INSERT INTO ledger_outbox (source_type, source_id, owner_id)
  SELECT DISTINCT k.source_type, k.source_id, k.owner_id
    FROM (SELECT o.* FROM ledger_old o JOIN ledger_new n ON n.id = o.id
           WHERE ROW(%s) IS DISTINCT FROM ROW(%s)
          UNION ALL
          SELECT n.* FROM ledger_old o JOIN ledger_new n ON n.id = o.id
           WHERE ROW(%s) IS DISTINCT FROM ROW(%s)) r
    CROSS JOIN LATERAL (%s) k(source_type, source_id, owner_id)
   WHERE k.source_id IS NOT NULL;
  RETURN NULL;
END $body$$f$, 'ledger_capture_' || p_table || '_upd', col_note, o_list, n_list, o_list, n_list, p_keys);

  EXECUTE format($f$
CREATE OR REPLACE FUNCTION %I() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
  -- ledger columns: %s
  INSERT INTO ledger_outbox (source_type, source_id, owner_id)
  SELECT DISTINCT k.source_type, k.source_id, k.owner_id
    FROM ledger_old r
    CROSS JOIN LATERAL (%s) k(source_type, source_id, owner_id)
   WHERE k.source_id IS NOT NULL;
  RETURN NULL;
END $body$$f$, 'ledger_capture_' || p_table || '_del', col_note, p_keys);

  -- 10/12 (Nic) review: a trigger is created only when it is missing or not
  -- exactly this one. Re-installing (a later phase widening the column list)
  -- only replaced the bodies above, which takes no table lock — a DROP TRIGGER
  -- would take ACCESS EXCLUSIVE and block even reads of a live money table.
  FOR ev IN SELECT * FROM (VALUES
      ('ins', 'INSERT', 4,  NULL::text,   'ledger_new'::text, 'REFERENCING NEW TABLE AS ledger_new'),
      ('upd', 'UPDATE', 16, 'ledger_old', 'ledger_new',       'REFERENCING OLD TABLE AS ledger_old NEW TABLE AS ledger_new'),
      ('del', 'DELETE', 8,  'ledger_old', NULL,               'REFERENCING OLD TABLE AS ledger_old')
    ) v(suffix, event, tgtype, old_t, new_t, refs)
  LOOP
    fn := format('public.%I()', 'ledger_capture_' || p_table || '_' || ev.suffix)::regprocedure;
    PERFORM 1 FROM pg_trigger g
     WHERE g.tgrelid = rel AND g.tgname = 'ledger_capture_' || ev.suffix AND NOT g.tgisinternal
       AND g.tgfoid = fn AND g.tgtype = ev.tgtype AND g.tgenabled = 'O'
       AND g.tgoldtable::text IS NOT DISTINCT FROM ev.old_t AND g.tgnewtable::text IS NOT DISTINCT FROM ev.new_t;
    IF NOT FOUND THEN
      EXECUTE format('CREATE OR REPLACE TRIGGER %I AFTER %s ON %I %s FOR EACH STATEMENT EXECUTE FUNCTION %s',
                     'ledger_capture_' || ev.suffix, ev.event, p_table, ev.refs, fn::text);
    END IF;
  END LOOP;

  -- Compile and run all three now: a statement that matches no row still
  -- fires a statement trigger, so a mistake fails this migration, not a
  -- money write. (OVERRIDING SYSTEM VALUE: a table whose id is GENERATED
  -- ALWAYS would otherwise refuse even an empty insert naming it.)
  EXECUTE format('INSERT INTO %I (id) OVERRIDING SYSTEM VALUE SELECT id FROM %I WHERE false', p_table, p_table);
  EXECUTE format('UPDATE %I SET id = id WHERE false', p_table);
  EXECUTE format('DELETE FROM %I WHERE false', p_table);
END $inst$;

COMMENT ON FUNCTION ledger_install_capture(text, text[], text) IS
  '10/12 (Nic, ledger §7): (re)installs a money table''s three statement-level capture triggers. p_keys: a SELECT over the changed row r giving (source_type, source_id, owner_id). Re-installing replaces the bodies only; a trigger is created only when missing.';

-- ── The guard against a later migration breaking a capture body ─────────────
-- Every capture table: each listed column still exists, and the three bodies
-- still compile and run. Raises in plain words naming the table.
CREATE OR REPLACE FUNCTION ledger_check_capture() RETURNS void
LANGUAGE plpgsql AS $chk$
DECLARE
  t       record;
  missing text[];
BEGIN
  FOR t IN
    SELECT c.relname, p.prosrc
      FROM pg_trigger g
      JOIN pg_class c ON c.oid = g.tgrelid
      JOIN pg_proc p ON p.oid = g.tgfoid
     WHERE g.tgname = 'ledger_capture_upd' AND NOT g.tgisinternal AND c.relnamespace = 'public'::regnamespace
     ORDER BY c.relname
  LOOP
    SELECT array_agg(col ORDER BY col) INTO missing
      FROM unnest(string_to_array(substring(t.prosrc FROM '-- ledger columns: ([^\n]*)'), ',')) col
     WHERE NOT EXISTS (SELECT 1 FROM pg_attribute a
                        WHERE a.attrelid = format('public.%I', t.relname)::regclass
                          AND a.attname = col AND a.attnum > 0 AND NOT a.attisdropped);
    IF missing IS NOT NULL THEN
      RAISE EXCEPTION 'The books capture on % reads column(s) % that this change removes or renames. Re-install its capture without them first (ledger_install_capture, LEDGER_CAPTURE_COLUMNS), then drop them.',
        t.relname, missing USING ERRCODE = 'dependent_objects_still_exist';
    END IF;
    BEGIN
      EXECUTE format('INSERT INTO %I (id) OVERRIDING SYSTEM VALUE SELECT id FROM %I WHERE false', t.relname, t.relname);
      EXECUTE format('UPDATE %I SET id = id WHERE false', t.relname);
      EXECUTE format('DELETE FROM %I WHERE false', t.relname);
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'This change breaks the books capture on % (%). Every write to % would fail. Re-install its capture to match first (ledger_install_capture).',
        t.relname, SQLERRM, t.relname USING ERRCODE = 'dependent_objects_still_exist';
    END;
  END LOOP;
END $chk$;

COMMENT ON FUNCTION ledger_check_capture() IS
  '10/12 (Nic, ledger §7 review): proves every money table''s capture still matches its table (columns exist, bodies compile and run). The DDL guard runs it; so may anyone.';

-- The event trigger's body: runs after ALTER TABLE / DROP TABLE.
CREATE OR REPLACE FUNCTION ledger_ddl_guard() RETURNS event_trigger
LANGUAGE plpgsql AS $guard$
DECLARE
  watched text[];
  gone    text[];
BEGIN
  -- Every table a capture body reads or writes: the capture tables, the
  -- outbox, and every table named after FROM / JOIN in a body.
  SELECT array_agg(DISTINCT n) INTO watched
    FROM (SELECT c.relname::text AS n
            FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid
           WHERE g.tgname = 'ledger_capture_upd' AND NOT g.tgisinternal AND c.relnamespace = 'public'::regnamespace
          UNION ALL
          -- (comments stripped; a name followed by "(" is a function or ROW(…), not a table)
          SELECT lower(m[1])
            FROM pg_proc p,
                 regexp_matches(regexp_replace(p.prosrc, '--[^\n]*', '', 'g'),
                                '\m(?:FROM|JOIN)\s+([A-Za-z_][A-Za-z0-9_]*)\M(?!\s*\()', 'gi') m
           WHERE p.proname LIKE 'ledger\_capture\_%' AND p.pronamespace = 'public'::regnamespace
          UNION ALL
          SELECT 'ledger_outbox') x
   WHERE n NOT IN ('ledger_old', 'ledger_new');
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'ledger_capture_upd' AND NOT tgisinternal) THEN
    RETURN;  -- no capture installed
  END IF;
  SELECT array_agg(w ORDER BY w) INTO gone FROM unnest(watched) w WHERE to_regclass('public.' || quote_ident(w)) IS NULL;
  IF gone IS NOT NULL THEN
    RAISE EXCEPTION 'This change removes or renames table(s) % that the books capture reads; every write to the money tables that read them would fail. Re-install those captures to match first (ledger_install_capture).',
      gone USING ERRCODE = 'dependent_objects_still_exist';
  END IF;
  IF TG_TAG = 'DROP TABLE' THEN
    RETURN;  -- a dropped table no capture reads
  END IF;
  IF EXISTS (SELECT 1 FROM pg_event_trigger_ddl_commands() d JOIN pg_class c ON c.oid = d.objid
              WHERE d.classid = 'pg_class'::regclass AND c.relnamespace = 'public'::regnamespace
                AND c.relname = ANY (watched)) THEN
    PERFORM ledger_check_capture();
  END IF;
END $guard$;

COMMENT ON FUNCTION ledger_ddl_guard() IS
  '10/12 (Nic, ledger §7 review): the event trigger ledger_ddl_guard. A schema change that would make a capture body fail (and with it every write to a money table) fails in its own migration instead.';

-- ── The company's opening posting, and the days a moved start date touches ──
CREATE OR REPLACE FUNCTION ledger_capture_books_start() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- 'opening': the company's opening posting. 'books_start': only when the
  -- date moves (not when it is first picked) — every source dated from the
  -- earlier of the two dates up to (not including) the later one changes
  -- sides of the start, and the engine re-projects each.
  INSERT INTO ledger_outbox (source_type, source_id, owner_id)
  SELECT v.source_type, v.source_id, NEW.id
    FROM (VALUES ('opening'::text, NEW.id::text),
                 ('books_start', CASE WHEN OLD.books_start_date IS NOT NULL AND NEW.books_start_date IS NOT NULL
                                      THEN NEW.id::text || '|' || least(OLD.books_start_date, NEW.books_start_date)::text
                                                        || '|' || greatest(OLD.books_start_date, NEW.books_start_date)::text END)) v(source_type, source_id)
   WHERE v.source_id IS NOT NULL;
  RETURN NULL;
END $$;

-- ── Every source table (design §7), and every dependent table a projector reads ─
-- One list: it names the tables locked up front and the installs, in order.
-- The settle and payout path's tables come last; payments is the very last.
CREATE TEMP TABLE ledger_capture_plan (
  ord  integer PRIMARY KEY,
  tbl  text NOT NULL,
  cols text[] NOT NULL,
  keys text NOT NULL
) ON COMMIT DROP;

INSERT INTO ledger_capture_plan (ord, tbl, cols, keys) VALUES
  (1, 'lease_prepaid_credits',
   ARRAY['lease_id', 'received_lease_id', 'tenant_id', 'amount_original', 'funded_by', 'received_at', 'voided_at', 'source_remittance_id', 'source_payment_id', 'left_by_choice_id'],
   $k$SELECT v.* FROM (SELECT (SELECT l.landlord_id FROM leases l WHERE l.id = COALESCE(r.received_lease_id, r.lease_id)) AS owner) o
      CROSS JOIN LATERAL (VALUES ('prepaid_credit'::text, r.id::text, o.owner), ('remittance', r.source_remittance_id::text, o.owner)) v$k$),
  (2, 'tenant_credits',
   ARRAY['landlord_id', 'tenant_id', 'lease_id', 'amount_original', 'category', 'status', 'voided_at'],
   $k$SELECT 'credit_use'::text, cu.id::text, r.landlord_id FROM credit_uses cu WHERE cu.tenant_credit_id = r.id$k$),
  (3, 'landlord_gam_charge_collections',
   ARRAY['charge_id', 'platform_transfer_intent_id', 'landlord_gam_debit_id', 'amount', 'collected_at'],
   $k$SELECT v.* FROM (SELECT (SELECT c.landlord_id FROM landlord_gam_charges c WHERE c.id = r.charge_id) AS owner) o
      CROSS JOIN LATERAL (VALUES ('gam_charge'::text, r.charge_id::text, o.owner),
                                 ('transfer_intent', r.platform_transfer_intent_id::text, o.owner),
                                 ('gam_debit', r.landlord_gam_debit_id::text, o.owner)) v$k$),
  (4, 'connect_payouts',
   ARRAY['stripe_payout_id', 'stripe_account_id', 'user_id', 'amount', 'status', 'arrival_date', 'failure_code'],
   $k$SELECT 'connect_payout'::text, r.id::text, NULL::uuid
      UNION ALL SELECT 'disbursement', d.id::text, d.landlord_id FROM disbursements d WHERE d.stripe_payout_id = r.stripe_payout_id$k$),
  (5, 'landlord_instant_margins',
   ARRAY['landlord_id', 'amount', 'status', 'collected_at', 'source_disbursement_id'],
   $k$SELECT 'instant_margin'::text, r.id::text, r.landlord_id$k$),
  (6, 'landlord_gam_charges',
   ARRAY['landlord_id', 'property_id', 'kind', 'amount', 'source_type', 'source_id', 'voided_at', 'created_at', 'reader_order_id', 'installment_number'],
   $k$SELECT v.* FROM (VALUES ('gam_charge'::text, r.id::text, r.landlord_id),
                           ('reader_order', r.reader_order_id::text, r.landlord_id)) v$k$),
  (7, 'landlord_gam_debits',
   ARRAY['landlord_id', 'charges_amount', 'bank_cost_amount', 'total_amount', 'status', 'charge_ids', 'settled_at'],
   $k$SELECT 'gam_debit'::text, r.id::text, r.landlord_id$k$),
  (8, 'pos_reader_orders',
   ARRAY['landlord_id', 'property_id', 'status', 'price', 'installments', 'installment_amount', 'installments_raised', 'shipped_at', 'cancelled_at'],
   $k$SELECT 'reader_order'::text, r.id::text, r.landlord_id$k$),
  (9, 'pos_refunds',
   ARRAY['transaction_id', 'landlord_id', 'amount', 'refund_method', 'card_fee_refunded', 'tax_refunded', 'stay_refund_part_id', 'reversed_at', 'created_at'],
   $k$SELECT 'pos_refund'::text, r.id::text, r.landlord_id$k$),
  (10, 'pos_eod_settlements',
   ARRAY['landlord_id', 'property_id', 'business_day', 'opening_float', 'cash_sales', 'cash_refunds', 'cash_drawer_actual', 'status', 'closed_at'],
   $k$SELECT 'pos_eod'::text, r.id::text, r.landlord_id$k$),
  (11, 'pos_held_payments',
   ARRAY['landlord_id', 'property_id', 'pay_link_id', 'booking_id', 'amount', 'stripe_fee_kept', 'status', 'refunded_at', 'created_at'],
   $k$SELECT 'pos_held'::text, r.id::text, r.landlord_id$k$),
  (12, 'unit_bookings',
   ARRAY['landlord_id', 'unit_id', 'tenant_id', 'status', 'check_in', 'check_out', 'booked_check_out', 'nights', 'total_amount', 'nightly_rate', 'deposit_amount', 'deposit_paid_at', 'balance_paid_at', 'cancelled_at', 'pos_transaction_id', 'lease_type'],
   $k$SELECT 'booking'::text, r.id::text, r.landlord_id$k$),
  (13, 'stay_payments',
   ARRAY['booking_id', 'landlord_id', 'kind', 'pos_transaction_id', 'method', 'toward_stay', 'card_fee', 'landlord_card_fee', 'lodging_tax_amount', 'paid_at'],
   $k$SELECT 'booking'::text, r.booking_id::text, r.landlord_id$k$),
  (14, 'stay_refund_parts',
   ARRAY['landlord_id', 'booking_id', 'decision_id', 'kind', 'stay_payment_id', 'remittance_id', 'prepaid_credit_id', 'pos_transaction_id', 'toward_amount', 'card_fee_back', 'amount', 'payout_drop', 'lodging_tax_share', 'status', 'refunded_at', 'reversed_at', 'replaces_part_id', 'paid_ahead_choice_id', 'deposit_return_id', 'deposit_payment_id'],
   $k$SELECT 'refund_part'::text, r.id::text, r.landlord_id$k$),
  (15, 'security_deposits',
   ARRAY['lease_id', 'tenant_id', 'unit_id', 'total_amount', 'status', 'held_by', 'flex_deposit_enabled', 'flex_deposit_plan_status', 'carried_from_deposit_id'],
   $k$SELECT 'security_deposit'::text, r.id::text, (SELECT l.landlord_id FROM leases l WHERE l.id = r.lease_id)$k$),
  (16, 'deposit_returns',
   ARRAY['landlord_id', 'lease_id', 'security_deposit_id', 'status', 'finalized_at', 'total_deposit', 'cleaning_fee_amount', 'damage_lines', 'other_deductions', 'total_deductions', 'refund_amount', 'gap_amount', 'unpaid_balance_amount', 'refund_from_gam', 'refund_from_landlord', 'refund_payment_id', 'gap_payment_id', 'landlord_part_handed_back_on'],
   $k$SELECT 'deposit_return'::text, r.id::text, r.landlord_id$k$),
  (17, 'home_sale_contracts',
   ARRAY['landlord_id', 'unit_id', 'tenant_id', 'sale_price', 'down_payment', 'financed_amount', 'annual_interest_rate', 'term_months', 'start_month', 'plan_type', 'status', 'cancelled_at', 'paid_off_at', 'created_at'],
   $k$SELECT v.* FROM (VALUES ('home_sale'::text, r.id::text, r.landlord_id),
                           ('opening', r.landlord_id::text, r.landlord_id)) v$k$),
  (18, 'landlord_expenses',
   ARRAY['landlord_id', 'property_id', 'unit_id', 'category', 'amount', 'expense_date', 'is_common', 'allocate_per_unit', 'status', 'voided_at', 'utility_type', 'vendor', 'bank_transaction_id'],
   $k$SELECT 'expense'::text, r.id::text, r.landlord_id$k$),
  (19, 'landlord_other_income',
   ARRAY['landlord_id', 'property_id', 'unit_id', 'category', 'amount', 'income_date', 'is_common', 'status', 'voided_at', 'bank_transaction_id'],
   $k$SELECT 'other_income'::text, r.id::text, r.landlord_id$k$),
  (20, 'bank_deposit_slips',
   ARRAY['landlord_id', 'property_id', 'deposit_date', 'total', 'other_amount', 'source', 'status', 'bank_transaction_id', 'matched_at', 'voided_at'],
   $k$SELECT 'deposit_slip'::text, r.id::text, r.landlord_id$k$),
  (21, 'bank_deposit_slip_items',
   ARRAY['slip_id', 'remittance_id', 'pos_transaction_id', 'amount', 'voided_at'],
   $k$SELECT 'deposit_slip'::text, r.slip_id::text, (SELECT s.landlord_id FROM bank_deposit_slips s WHERE s.id = r.slip_id)$k$),
  (22, 'payroll_runs',
   ARRAY['landlord_id', 'business_id', 'pay_date', 'status', 'total_gross', 'total_federal_tax', 'total_state_tax', 'total_ss', 'total_medicare', 'total_net', 'approved_at', 'voided_at'],
   $k$SELECT 'payroll_run'::text, r.id::text, COALESCE(r.landlord_id, r.business_id)$k$),
  (23, 'payroll_run_lines',
   ARRAY['run_id', 'employee_id', 'gross_pay', 'federal_tax', 'state_tax', 'ss_tax', 'medicare_tax', 'other_deductions', 'net_pay'],
   $k$SELECT 'payroll_run'::text, r.run_id::text, (SELECT COALESCE(pr.landlord_id, pr.business_id) FROM payroll_runs pr WHERE pr.id = r.run_id)$k$),
  (24, 'journal_entries',
   ARRAY['landlord_id', 'business_id', 'date', 'type', 'status', 'voided_at', 'reverses_entry_id', 'adjusts_line_key'],
   $k$SELECT 'manual_journal'::text, r.id::text, COALESCE(r.landlord_id, r.business_id)$k$),
  (25, 'journal_entry_lines',
   ARRAY['entry_id', 'account_id', 'debit', 'credit', 'property_id', 'unit_id', 'lease_id'],
   $k$SELECT 'manual_journal'::text, r.entry_id::text, (SELECT COALESCE(je.landlord_id, je.business_id) FROM journal_entries je WHERE je.id = r.entry_id)$k$),
  (26, 'property_transfers',
   ARRAY['property_id', 'from_landlord_id', 'to_landlord_id', 'transferred_at', 'moved'],
   $k$SELECT v.* FROM (VALUES ('property_transfer'::text, r.id::text, r.from_landlord_id),
                           ('property_transfer', r.id::text, r.to_landlord_id)) v$k$),
  (27, 'work_trade_extra_hours',
   ARRAY['landlord_id', 'tenant_id', 'agreement_id', 'period_month', 'hours', 'rate', 'amount', 'pay_method', 'status', 'paid_on', 'paid_at', 'books_reference_id'],
   $k$SELECT 'work_trade_hours'::text, r.id::text, r.landlord_id$k$),
  (28, 'books_opening_items',
   ARRAY['landlord_id', 'business_id', 'kind', 'lease_id', 'tenant_id', 'property_id', 'bank_connection_id', 'amount', 'as_of', 'voided_at'],
   $k$SELECT 'opening'::text, COALESCE(r.landlord_id, r.business_id)::text, COALESCE(r.landlord_id, r.business_id)$k$),
  (29, 'home_sale_installments',
   ARRAY['contract_id', 'payment_id', 'billing_month', 'amount', 'principal_portion', 'interest_portion', 'settled_off_platform_at'],
   $k$SELECT v.* FROM (SELECT (SELECT c.landlord_id FROM home_sale_contracts c WHERE c.id = r.contract_id) AS owner) o
      CROSS JOIN LATERAL (VALUES ('payment'::text, r.payment_id::text, o.owner),
                                 ('home_sale', r.contract_id::text, o.owner),
                                 ('opening', o.owner::text, o.owner)) v$k$),
  (30, 'flex_deposit_installments',
   ARRAY['payment_id', 'security_deposit_id'],
   $k$SELECT 'payment'::text, r.payment_id::text, (SELECT p.landlord_id FROM payments p WHERE p.id = r.payment_id)$k$),
  (31, 'pos_transaction_items',
   ARRAY['transaction_id', 'item_id', 'item_category', 'qty', 'unit_price', 'cost_price', 'tax_rate', 'subtotal'],
   $k$SELECT 'pos_sale'::text, r.transaction_id::text, (SELECT t.landlord_id FROM pos_transactions t WHERE t.id = r.transaction_id)$k$),
  (32, 'pos_transactions',
   ARRAY['landlord_id', 'property_id', 'tenant_id', 'payment_method', 'subtotal', 'discount_amount', 'tax_amount', 'tax_breakdown', 'surcharge', 'total', 'platform_fee', 'status', 'voided_at', 'created_at', 'pay_link_id', 'paid_online'],
   $k$SELECT 'pos_sale'::text, r.id::text, r.landlord_id$k$),
  (33, 'bank_transactions',
   ARRAY['bank_connection_id', 'landlord_id', 'posted_date', 'amount', 'status', 'matched_payment_id', 'matched_disbursement_id', 'expense_id', 'landlord_other_income_id'],
   $k$SELECT 'bank_match'::text, r.id::text, r.landlord_id$k$),
  (34, 'bank_deposit_allocations',
   ARRAY['bank_transaction_id', 'payment_id', 'landlord_id', 'amount', 'effective_paid_date', 'reversed_at'],
   $k$SELECT 'bank_match'::text, r.bank_transaction_id::text, r.landlord_id
      UNION ALL SELECT 'payment', r.payment_id::text, r.landlord_id
      UNION ALL SELECT 'remittance', ra.remittance_id::text, r.landlord_id FROM remittance_applications ra WHERE ra.payment_id = r.payment_id$k$),
  (35, 'lease_fees',
   ARRAY['fee_type', 'money_kind', 'is_refundable', 'due_timing'],
   $k$SELECT 'payment'::text, p.id::text, p.landlord_id FROM payments p WHERE p.lease_fee_id = r.id$k$),
  (36, 'invoices',
   ARRAY['is_opening_balance', 'work_trade_credit_amount'],
   $k$SELECT 'payment'::text, p.id::text, p.landlord_id FROM payments p WHERE p.invoice_id = r.id$k$),
  (37, 'utility_bills',
   ARRAY['payment_id', 'meter_id', 'landlord_id', 'charge_amount', 'tax_amount', 'utility_type'],
   $k$SELECT 'payment'::text, r.payment_id::text, r.landlord_id$k$),
  (38, 'allocation_splits',
   ARRAY['payment_id', 'landlord_id', 'property_id', 'remittance_id', 'credit_use_id', 'gross_held', 'landlord_fee_withheld', 'landlord_fee_uncovered', 'supersedence', 'sublease_markup', 'pm_fee_due', 'pm_paid', 'manager_fee_due', 'manager_paid', 'short_by', 'owner_share'],
   $k$SELECT 'allocation'::text, r.id::text, r.landlord_id$k$),
  (39, 'payment_reversals',
   ARRAY['payment_id', 'landlord_id', 'tenant_id', 'lease_id', 'reversal_type', 'reversed_amount', 'reversal_fee', 'status', 'outcome', 'recovery_method', 'recovery_status', 'recovered_amount', 'recovered_at', 'resolved_at', 'created_at'],
   $k$SELECT 'payment_reversal'::text, r.id::text, r.landlord_id$k$),
  (40, 'held_payout_items',
   ARRAY['landlord_id', 'business_id', 'property_id', 'source_type', 'source_id', 'amount', 'payout_intent_id', 'created_at'],
   $k$SELECT v.* FROM (VALUES ('held_item'::text, r.id::text, COALESCE(r.landlord_id, r.business_id)),
                           ('transfer_intent', r.payout_intent_id::text, COALESCE(r.landlord_id, r.business_id))) v$k$),
  (41, 'platform_transfer_intents',
   ARRAY['landlord_id', 'business_id', 'destination_connect_account_id', 'amount', 'gross_owed', 'netted_amount', 'status', 'transferred_at', 'purpose', 'deposit_return_id', 'flexcharge_statement_id', 'disbursement_id'],
   $k$SELECT 'transfer_intent'::text, r.id::text, COALESCE(r.landlord_id, r.business_id)$k$),
  (42, 'disbursements',
   ARRAY['landlord_id', 'user_id', 'amount', 'status', 'settled_at', 'initiated_at', 'fee_charged', 'stripe_payout_id', 'stripe_account_id', 'bank_account_id', 'trigger_type'],
   $k$SELECT 'disbursement'::text, r.id::text, r.landlord_id$k$),
  (43, 'credit_uses',
   ARRAY['tenant_credit_id', 'prepaid_credit_id', 'payment_id', 'deposit_return_id', 'payment_reversal_id', 'remittance_id', 'refund_part_id', 'paid_ahead_choice_id', 'lease_id', 'amount', 'source', 'status', 'applied_at', 'released_at'],
   $k$SELECT 'credit_use'::text, r.id::text, COALESCE((SELECT p.landlord_id FROM payments p WHERE p.id = r.payment_id),
                                                (SELECT d.landlord_id FROM deposit_returns d WHERE d.id = r.deposit_return_id))$k$),
  (44, 'remittance_applications',
   ARRAY['remittance_id', 'payment_id', 'amount_applied'],
   $k$SELECT 'remittance'::text, r.remittance_id::text, (SELECT p.landlord_id FROM payments p WHERE p.id = r.payment_id)$k$),
  (45, 'tenant_remittances',
   ARRAY['landlord_id', 'tenant_id', 'lease_id', 'amount', 'applied_amount', 'unapplied_amount', 'gross_amount', 'processing_fee_amount', 'status', 'payment_method', 'settled_at', 'undone_at'],
   $k$SELECT 'remittance'::text, r.id::text, r.landlord_id$k$),
  (46, 'payments',
   ARRAY['landlord_id', 'unit_id', 'lease_id', 'tenant_id', 'type', 'amount', 'status', 'due_date', 'settled_at', 'entry_description', 'lease_fee_id', 'invoice_id', 'reversal_id', 'revenue_owner', 'manual_method', 'voided_at', 'home_sale_installment_id', 'flexpay_advance_id', 'is_remainder', 'sublease_markup_amount', 'gam_supersedence_amount', 'payment_channel', 'issued_credit_amount', 'deposit_collected_by'],
   $k$SELECT 'payment'::text, r.id::text, r.landlord_id
      UNION ALL SELECT 'remittance', ra.remittance_id::text, r.landlord_id FROM remittance_applications ra WHERE ra.payment_id = r.id$k$);

-- Lock every table this migration triggers in ONE statement, NOWAIT, retried
-- (see LOCKS in the header): never waiting, never holding while it retries.
DO $lock$
DECLARE
  tables text;
  tries  integer := 0;
BEGIN
  SELECT string_agg(format('%I', tbl), ', ' ORDER BY ord) INTO tables
    FROM (SELECT ord, tbl FROM ledger_capture_plan WHERE to_regclass('public.' || quote_ident(tbl)) IS NOT NULL
          UNION ALL SELECT 1000000, 'landlords') x;
  LOOP
    BEGIN
      EXECUTE format('LOCK TABLE %s IN SHARE ROW EXCLUSIVE MODE NOWAIT', tables);
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      tries := tries + 1;
      IF tries >= 300 THEN
        RAISE EXCEPTION 'ledger capture: the money tables never went quiet for an instant in ~30 s; this migration runs again at the next start'
          USING ERRCODE = 'lock_not_available';
      END IF;
      PERFORM pg_sleep(0.05 + random() * 0.1);
    END;
  END LOOP;
END $lock$;

DO $install$
DECLARE
  p record;
BEGIN
  FOR p IN SELECT tbl, cols, keys FROM ledger_capture_plan ORDER BY ord LOOP
    PERFORM ledger_install_capture(p.tbl, p.cols, p.keys);
  END LOOP;
END $install$;

-- landlords.books_start_date: one row trigger, created once (last: the
-- company row is the busiest row of all).
DO $books_start$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgrelid = 'landlords'::regclass AND tgname = 'ledger_capture_books_start' AND NOT tgisinternal) THEN
    EXECUTE 'CREATE TRIGGER ledger_capture_books_start
               AFTER UPDATE OF books_start_date ON landlords
               FOR EACH ROW WHEN (OLD.books_start_date IS DISTINCT FROM NEW.books_start_date)
               EXECUTE FUNCTION ledger_capture_books_start()';
  END IF;
END $books_start$;

-- The DDL guard (needs a superuser; see the header).
DO $ddl_guard$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_event_trigger WHERE evtname = 'ledger_ddl_guard') THEN
    EXECUTE 'CREATE EVENT TRIGGER ledger_ddl_guard ON ddl_command_end
               WHEN TAG IN (''ALTER TABLE'', ''DROP TABLE'')
               EXECUTE FUNCTION ledger_ddl_guard()';
  END IF;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'ledger capture: not a superuser, so the DDL guard (event trigger ledger_ddl_guard) is not installed; services/ledgerCoverage.test.ts still holds every capture to its table';
END $ddl_guard$;

-- Everything installed matches its table.
SELECT ledger_check_capture();
