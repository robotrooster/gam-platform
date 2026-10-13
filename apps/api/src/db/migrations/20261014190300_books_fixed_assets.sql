-- 10/12 (Nic) — GAM BOOKS: FIXED ASSETS AND MONTHLY DEPRECIATION
--
-- Nic, 10/12: fixed assets with depreciation are part of this build. A
-- building, an improvement to a property, equipment or a vehicle wears out
-- over years; its cost is spread over the life the landlord chooses, a month
-- at a time (straight line), instead of landing as one expense the month it
-- was bought. Land never wears out.
--
--   books_fixed_assets   one asset per row, on a property or the company:
--                        what it is (asset_class), its cost and what it will
--                        be worth at the end (salvage_value), the day it was
--                        bought (acquired_on) and put in service
--                        (in_service_date), the life in years the landlord
--                        chooses (life_years — whole months), the method
--                        (straight line). source_expense_id: the expense it
--                        was made from (an expense filed under a
--                        capital-improvement category — one that charges to an
--                        asset account).
--
-- What posts (services/ledgerProjectors/loansAssets.ts, source 'fixed_asset'):
--   '<asset id>'          an asset bought before the books start date opens on
--                         that date: Dr its account (Rental property or
--                         Equipment, by class) for the cost, Cr Accumulated
--                         depreciation for what was already taken
--                         (prior_depreciation, or the schedule's months before
--                         the start), Cr Opening balance equity for the rest.
--                         An asset bought on or after the start posts no cost
--                         of its own: its cost is already on the books through
--                         how it was paid (its expense, the loan that bought
--                         it, or a journal entry) — never twice.
--   '<asset id>|YYYY-MM'  that month's depreciation, on the month's last day:
--                         Dr Depreciation (5170), Cr Accumulated depreciation
--                         (1510). Months that ended before the books start are
--                         held back (the opening carries them). A month posts
--                         once it has ended: saving an asset marks every month
--                         that ended, and the nightly books job marks each new
--                         one (services/booksVendorsLoans
--                         markDepreciationMonthsDue).
--
-- An expense an asset was made from cannot be voided while the asset stands
-- (its cost would leave the books while its depreciation went on): the guard
-- below refuses it, saying to void the asset first.
--
-- Keep-everything: never deleted; an asset entered by mistake is voided (who,
-- when, why) and its postings are taken back. The change journal and the
-- ledger capture are on it.
--
-- Expand-only; a new table. No backfill needed.
-- Safe drop: the expense guard trigger and function, the table (after its
-- capture), its guard function.

SET LOCAL lock_timeout = '10s';

CREATE TABLE IF NOT EXISTS books_fixed_assets (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  landlord_id         uuid REFERENCES landlords(id),
  business_id         uuid REFERENCES businesses(id),
  property_id         uuid REFERENCES properties(id),
  name                text NOT NULL,
  asset_class         text NOT NULL,
  cost                numeric(12,2) NOT NULL,
  salvage_value       numeric(12,2) NOT NULL DEFAULT 0,
  acquired_on         date NOT NULL,
  in_service_date     date NOT NULL,
  life_years          numeric(5,2),
  method              text NOT NULL DEFAULT 'straight_line',
  prior_depreciation  numeric(12,2),
  source_expense_id   uuid REFERENCES landlord_expenses(id),
  notes               text,
  created_by          uuid REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  voided_at           timestamptz,
  voided_by           uuid REFERENCES users(id),
  void_reason         text,
  CONSTRAINT books_fixed_assets_one_owner CHECK (num_nonnulls(landlord_id, business_id) = 1),
  CONSTRAINT books_fixed_assets_name_check CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  CONSTRAINT books_fixed_assets_class_check CHECK (asset_class IN ('building', 'improvement', 'equipment', 'vehicle', 'land')),
  CONSTRAINT books_fixed_assets_method_check CHECK (method IN ('straight_line')),
  CONSTRAINT books_fixed_assets_cost_check CHECK (cost > 0 AND salvage_value >= 0 AND salvage_value <= cost),
  CONSTRAINT books_fixed_assets_dates_check CHECK (in_service_date >= acquired_on),
  -- A life in whole months (27.5 years = 330 months), up to 100 years; land has none.
  CONSTRAINT books_fixed_assets_life_check CHECK (
    (asset_class = 'land' AND life_years IS NULL)
    OR (asset_class <> 'land' AND life_years > 0 AND life_years <= 100 AND life_years * 12 = round(life_years * 12))),
  CONSTRAINT books_fixed_assets_prior_check CHECK (
    prior_depreciation IS NULL OR (prior_depreciation >= 0 AND prior_depreciation <= cost - salvage_value
                                   AND asset_class <> 'land' AND source_expense_id IS NULL)),
  CONSTRAINT books_fixed_assets_void_is_stamped CHECK ((voided_by IS NULL AND void_reason IS NULL) OR voided_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS books_fixed_assets_landlord ON books_fixed_assets (landlord_id) WHERE landlord_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS books_fixed_assets_business ON books_fixed_assets (business_id) WHERE business_id IS NOT NULL;
-- One live asset per expense.
CREATE UNIQUE INDEX IF NOT EXISTS books_fixed_assets_one_per_expense
  ON books_fixed_assets (source_expense_id) WHERE source_expense_id IS NOT NULL AND voided_at IS NULL;

COMMENT ON TABLE books_fixed_assets IS
  '10/12 (Nic): fixed assets — cost spread over the life the landlord chooses, straight line, one posting a month (Dr Depreciation / Cr Accumulated depreciation). One bought before the books start opens at its cost less what was already taken. Never deleted; voided.';
COMMENT ON COLUMN books_fixed_assets.prior_depreciation IS
  '10/12: for an asset bought before the books start, the depreciation already taken by then (from the owner''s earlier records). NULL: the straight-line months before the start.';
COMMENT ON COLUMN books_fixed_assets.source_expense_id IS
  '10/12 (Nic): the expense this asset was made from (filed under a capital-improvement category — one charging to an asset account). Its cost is on the books through that expense.';

CREATE OR REPLACE FUNCTION books_fixed_assets_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A fixed asset is never removed; void it instead.' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'Fixed asset % was voided: it is a record and does not change.', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.landlord_id IS DISTINCT FROM OLD.landlord_id OR NEW.business_id IS DISTINCT FROM OLD.business_id
     OR NEW.source_expense_id IS DISTINCT FROM OLD.source_expense_id THEN
    RAISE EXCEPTION 'A fixed asset''s company and the expense it was made from never change.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS books_fixed_assets_guard ON books_fixed_assets;
CREATE TRIGGER books_fixed_assets_guard BEFORE UPDATE OR DELETE ON books_fixed_assets
  FOR EACH ROW EXECUTE FUNCTION books_fixed_assets_guard();

-- The expense an asset stands on stays: voiding it would take the cost off the
-- books while the depreciation went on.
CREATE OR REPLACE FUNCTION landlord_expenses_asset_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  a record;
BEGIN
  IF (NEW.status IS DISTINCT FROM 'active' OR NEW.voided_at IS NOT NULL)
     AND OLD.status = 'active' AND OLD.voided_at IS NULL THEN
    SELECT f.name INTO a FROM books_fixed_assets f WHERE f.source_expense_id = NEW.id AND f.voided_at IS NULL LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'This expense became the fixed asset "%". Void the asset on the Fixed assets page first.', a.name
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS landlord_expenses_asset_guard ON landlord_expenses;
CREATE TRIGGER landlord_expenses_asset_guard BEFORE UPDATE OF status, voided_at ON landlord_expenses
  FOR EACH ROW EXECUTE FUNCTION landlord_expenses_asset_guard();

DROP TRIGGER IF EXISTS audit_books_fixed_assets ON books_fixed_assets;
CREATE TRIGGER audit_books_fixed_assets AFTER DELETE OR UPDATE ON books_fixed_assets
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();

-- ── The ledger capture (LEDGER_CAPTURE_COLUMNS in packages/shared) ──────────
-- An asset's change marks its opening and every month of its life that has
-- ended, from its books start on (months before the start are held back
-- anyway). The UPDATE capture runs this for the row as it was and as it is,
-- so months a shorter life or a later in-service date drops are taken back.
SELECT ledger_install_capture('books_fixed_assets',
  ARRAY['landlord_id', 'business_id', 'property_id', 'name', 'asset_class', 'cost', 'salvage_value',
        'acquired_on', 'in_service_date', 'life_years', 'method', 'prior_depreciation', 'source_expense_id', 'voided_at'],
  $k$SELECT 'fixed_asset'::text, r.id::text, COALESCE(r.landlord_id, r.business_id)
      UNION ALL
      SELECT 'fixed_asset', r.id::text || '|' || to_char(m, 'YYYY-MM'), COALESCE(r.landlord_id, r.business_id)
        FROM generate_series(
               date_trunc('month', GREATEST(r.in_service_date,
                 COALESCE((SELECT l.books_start_date FROM landlords l WHERE l.id = r.landlord_id), r.in_service_date))),
               date_trunc('month', r.in_service_date)
                 + make_interval(months => COALESCE(round(r.life_years * 12)::int, 0) - 1),
               interval '1 month') AS m
       WHERE r.life_years IS NOT NULL
         AND (m + interval '1 month')::date <= CURRENT_DATE$k$);

-- Everything installed still matches its table.
SELECT ledger_check_capture();
