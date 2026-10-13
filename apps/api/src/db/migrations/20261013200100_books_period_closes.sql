-- 10/12 (Nic) — GAM BOOKS LEDGER: CLOSING A MONTH, WITH ITS HISTORY
--
-- A company may close a month so its numbers stop changing (gam-ledger-design-
-- 2026-10-12 §13). Nic, 10/12 (L3): closing is optional and the owner decides
-- who may close and who may reopen (landlords.books_close_by / books_reopen_by,
-- 20261013200000). Operations are NEVER blocked by a close: a payment, a fix or
-- a late bank match dated in a closed month still happens — its ledger lines
-- land on the first open day, keep their real date as intended_date, and read
-- as "corrections to September, posted in October".
--
-- books_period_closes is the history: one row per close or reopen, never
-- changed or removed. The company's lock is the LATEST row's closed_through
-- (ledger_closed_through()); a reopen writes a row with the earlier date (NULL
-- when nothing stays closed), so reopening a month reopens the later ones too.
-- A reopen always says why.
--
-- ledger_close_balances is the snapshot a close takes of every account's
-- balance per property through the closed date, inside the close's own
-- transaction (under the exclusive owner lock, services/ledgerClose), so the
-- nightly check can prove nothing ever entered a closed month afterwards.
--
-- Both tables are append-only (a trigger refuses UPDATE and DELETE; TRUNCATE is
-- left for the test harness). Values match LEDGER_CLOSE_ACTIONS in
-- packages/shared/src/booksLedger.ts.
--
-- The ledger is DARK: no screen closes a month yet. Expand-only.
-- No backfill needed (no company has closed anything).
-- Safe drop: the two tables, ledger_closed_through() and the guard function.

SET LOCAL lock_timeout = '10s';

CREATE TABLE IF NOT EXISTS books_period_closes (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  landlord_id     uuid REFERENCES landlords(id),
  business_id     uuid REFERENCES businesses(id),
  action          text NOT NULL,
  closed_through  date,
  reason          text,
  acted_by        uuid REFERENCES users(id),
  acted_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT books_period_closes_one_owner CHECK (num_nonnulls(landlord_id, business_id) = 1),
  CONSTRAINT books_period_closes_action_check CHECK (action IN ('close', 'reopen')),
  CONSTRAINT books_period_closes_close_has_date CHECK (action <> 'close' OR closed_through IS NOT NULL),
  CONSTRAINT books_period_closes_month_end CHECK (
    closed_through IS NULL
    OR closed_through = (date_trunc('month', closed_through::timestamp) + interval '1 month' - interval '1 day')::date),
  CONSTRAINT books_period_closes_reopen_says_why CHECK (
    action <> 'reopen' OR length(btrim(COALESCE(reason, ''))) > 0)
);

CREATE INDEX IF NOT EXISTS books_period_closes_landlord ON books_period_closes (landlord_id, id DESC) WHERE landlord_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS books_period_closes_business ON books_period_closes (business_id, id DESC) WHERE business_id IS NOT NULL;

COMMENT ON TABLE books_period_closes IS
  '10/12 (Nic, ledger §13): every month close and reopen, never changed. The latest row''s closed_through is the company''s lock (ledger_closed_through()).';

CREATE TABLE IF NOT EXISTS ledger_close_balances (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  close_id     bigint NOT NULL REFERENCES books_period_closes(id),
  landlord_id  uuid REFERENCES landlords(id),
  business_id  uuid REFERENCES businesses(id),
  account_id   uuid NOT NULL REFERENCES books_accounts(id),
  property_id  uuid,
  debits       numeric(14,2) NOT NULL,
  credits      numeric(14,2) NOT NULL,
  CONSTRAINT ledger_close_balances_one_owner CHECK (num_nonnulls(landlord_id, business_id) = 1)
);

CREATE INDEX IF NOT EXISTS ledger_close_balances_close ON ledger_close_balances (close_id);

COMMENT ON TABLE ledger_close_balances IS
  '10/12 (Nic, ledger §13): each account''s debits and credits per property through a close''s date, taken inside the close. The nightly check proves the closed months never changed.';

-- The company's lock date: the latest close/reopen row's closed_through.
CREATE OR REPLACE FUNCTION ledger_closed_through(p_landlord uuid, p_business uuid) RETURNS date
LANGUAGE sql STABLE AS $$
  SELECT c.closed_through
    FROM books_period_closes c
   WHERE (p_landlord IS NOT NULL AND c.landlord_id = p_landlord)
      OR (p_landlord IS NULL AND p_business IS NOT NULL AND c.business_id = p_business)
   ORDER BY c.id DESC
   LIMIT 1
$$;

CREATE OR REPLACE FUNCTION books_period_closes_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is a record of the books as they were closed; it is never changed or removed (%).', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'check_violation';
END $$;

DROP TRIGGER IF EXISTS books_period_closes_append_only ON books_period_closes;
CREATE TRIGGER books_period_closes_append_only
  BEFORE UPDATE OR DELETE ON books_period_closes
  FOR EACH ROW EXECUTE FUNCTION books_period_closes_append_only();

DROP TRIGGER IF EXISTS ledger_close_balances_append_only ON ledger_close_balances;
CREATE TRIGGER ledger_close_balances_append_only
  BEFORE UPDATE OR DELETE ON ledger_close_balances
  FOR EACH ROW EXECUTE FUNCTION books_period_closes_append_only();
