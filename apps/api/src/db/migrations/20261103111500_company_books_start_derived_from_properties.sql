-- 11/3 — THE COMPANY'S BOOKS START BECOMES DERIVED: THE EARLIEST OF ITS PROPERTIES'.
--
-- Nic, 11/2: "If I have one property now and I buy another property later, my
-- books for that property are going to start from when I bought that property.
-- Whether or not it's the same LLC is irrelevant. It's a completely separate
-- business revenue stream."
--
-- Step 1 of per-property books (PER_PROPERTY_BOOKS_PLAN.md). This is the only
-- step that is safe to ship on its own, and it is safe because every company
-- with books today holds exactly ONE property, so the earliest of its
-- properties' dates IS its date and nothing observable changes.
--
-- ── WHY THE COMPANY KEEPS A DATE AT ALL ────────────────────────────────────
-- A bank account cannot be split between properties: bank_connections,
-- bank_transactions, bank_reconciliations, bank_reconciliation_items and
-- bank_deposit_slips have no property_id. So anything keyed to the bank — the
-- sync cutoff, reconciliation, the review queue — needs ONE date per company.
-- The honest one is the earliest of its properties', because a company's books
-- begin when its first property's do. landlords.books_start_date therefore
-- stays, and stops being something a person sets directly: it becomes a mirror
-- that this migration keeps true.
--
-- ── NO LOOP ────────────────────────────────────────────────────────────────
-- Verified before writing this, not assumed: of the four triggers on
-- `landlords` (audit_landlords, books_start_asset_loan_guard,
-- ledger_capture_books_start, trg_landlords_updated_at) NONE writes
-- `properties`, and of the seven on `properties` none writes `landlords`. So a
-- properties write that updates landlords cannot come back around.
--
-- ── THE TWO GUARDS MOVE WITH IT ────────────────────────────────────────────
-- books_start_asset_loan_guard refuses a books start that would put a fixed
-- asset and the loan that paid for it on opposite sides of the start day (the
-- asset's cost would count twice, or not at all). It keyed on
-- `f.landlord_id = NEW.id` on a landlords trigger, which means TODAY an asset
-- at property A can block property B's date. Re-pointed to
-- `f.property_id = NEW.id` on a properties trigger it becomes both correct and
-- stricter: each property's date is checked against its own assets.
--
-- books_loans_asset_guard (on books_loans) read the same date through
-- `JOIN landlords x ON x.id = f.landlord_id`. It now reads the asset's
-- PROPERTY's date, falling back to the company's earliest for an asset that
-- names no property. The plan did not name this one; it was found by asking
-- the database which functions mention books_start rather than by reading the
-- plan's list.
--
-- SAFE: books_fixed_assets, books_loans, books_fixed_asset_funding and
-- books_opening_items all hold ZERO rows right now, so neither guard is
-- guarding any live row and the re-point cannot refuse anything that works
-- today. books_period_closes and ledger_close_balances are empty too.
--
-- NO BACKFILL NEEDED: 20261102140000 already copied each company's date onto
-- every property it holds, so MIN(properties) already equals landlords today.
-- The backfill at the end is a no-op assertion that proves it.
--
-- Re-runnable.

-- ── 1. the mirror ───────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION properties_derive_company_books_start() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  lid uuid;
BEGIN
  -- Both companies when a property moves between them, so neither is left
  -- mirroring a property it no longer holds.
  FOR lid IN
    SELECT DISTINCT x FROM unnest(ARRAY[
      CASE WHEN TG_OP <> 'INSERT' THEN OLD.landlord_id END,
      CASE WHEN TG_OP <> 'DELETE' THEN NEW.landlord_id END]) AS t(x)
     WHERE x IS NOT NULL
  LOOP
    -- IS DISTINCT FROM: write only when the earliest actually moves, so
    -- ledger_capture_books_start (AFTER UPDATE ... WHEN changed) fires exactly
    -- when the company's effective start moved and not on every property save.
    UPDATE landlords l
       SET books_start_date = sub.d
      FROM (SELECT min(p.books_start_date) AS d
              FROM properties p WHERE p.landlord_id = lid) sub
     WHERE l.id = lid
       AND l.books_start_date IS DISTINCT FROM sub.d;
  END LOOP;
  RETURN NULL;
END $$;

COMMENT ON FUNCTION properties_derive_company_books_start() IS
  'Keeps landlords.books_start_date = MIN(properties.books_start_date) for that
   company. The company date is a MIRROR, not a setting: write the property
   (services/bankFeed.setBooksStartDate) and let this derive the company''s.
   It exists because bank tables are company-scoped and cannot be split.';

DROP TRIGGER IF EXISTS trg_properties_derive_books_start ON properties;
CREATE TRIGGER trg_properties_derive_books_start
  AFTER INSERT OR DELETE OR UPDATE OF books_start_date, landlord_id ON properties
  FOR EACH ROW EXECUTE FUNCTION properties_derive_company_books_start();

-- ── 2. the asset/loan guard moves to the property ───────────────────────────
CREATE OR REPLACE FUNCTION books_start_asset_loan_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  a record;
BEGIN
  SELECT f.name AS asset_name, f.acquired_on, l.name AS loan_name, l.start_date INTO a
    FROM books_fixed_assets f JOIN books_loans l ON l.id = f.funded_loan_id
   WHERE f.property_id = NEW.id AND f.voided_at IS NULL AND f.funded_by = 'loan'
     AND (l.start_date < NEW.books_start_date) <> (f.acquired_on < NEW.books_start_date)
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'This property''s books cannot start on %: the fixed asset "%" (bought on %) and the loan "%" that paid for it (made on %) would be on different sides of that day, so the asset''s cost would count twice, or not at all. Change the asset''s day or the loan''s first.',
      NEW.books_start_date, a.asset_name, a.acquired_on, a.loan_name, a.start_date
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT f.name AS asset_name, f.acquired_on, l.name AS loan_name, l.start_date INTO a
    FROM books_fixed_assets f
    JOIN books_fixed_asset_funding x ON x.asset_id = f.id AND x.replaced_at IS NULL AND x.kind IN ('loan', 'expense')
    LEFT JOIN books_loans l ON l.id = x.loan_id
   WHERE f.property_id = NEW.id AND f.voided_at IS NULL
     AND (f.acquired_on < NEW.books_start_date OR l.start_date < NEW.books_start_date)
   ORDER BY f.acquired_on, f.id
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'This property''s books cannot start on %: the fixed asset "%" (bought on %) was paid for in part by %, which would then be before the books start, so part of its cost would count twice. Change where that asset''s money came from first.',
      NEW.books_start_date, a.asset_name, a.acquired_on,
      CASE WHEN a.loan_name IS NOT NULL THEN format('the loan "%s" (made on %s)', a.loan_name, a.start_date) ELSE 'an expense' END
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

-- Off landlords (where it checked the company's mirror against every property's
-- assets) and onto properties (where the person's intent actually lands).
DROP TRIGGER IF EXISTS books_start_asset_loan_guard ON landlords;
DROP TRIGGER IF EXISTS books_start_asset_loan_guard ON properties;
CREATE TRIGGER books_start_asset_loan_guard
  BEFORE UPDATE OF books_start_date ON properties
  FOR EACH ROW
  WHEN (NEW.books_start_date IS NOT NULL AND NEW.books_start_date IS DISTINCT FROM OLD.books_start_date)
  EXECUTE FUNCTION books_start_asset_loan_guard();

-- ── 3. the loan guard reads the asset's property, not the company ───────────
CREATE OR REPLACE FUNCTION books_loans_asset_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  a record;
BEGIN
  IF (NEW.voided_at IS NOT NULL AND OLD.voided_at IS NULL) OR NEW.funded_to IS DISTINCT FROM OLD.funded_to THEN
    SELECT f.name INTO a FROM books_fixed_assets f
     WHERE f.voided_at IS NULL
       AND (f.funded_loan_id = NEW.id
            OR EXISTS (SELECT 1 FROM books_fixed_asset_funding x WHERE x.asset_id = f.id AND x.loan_id = NEW.id AND x.replaced_at IS NULL))
     LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'This loan paid for the fixed asset "%". Void the asset on the Fixed assets page first.', a.name
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW.start_date IS DISTINCT FROM OLD.start_date THEN
    -- The asset's own property decides the start day; an asset that names no
    -- property falls back to the company's earliest, which is the mirror.
    SELECT f.name, f.acquired_on,
           COALESCE(pr.books_start_date, c.books_start_date) AS books_start_date
      INTO a
      FROM books_fixed_assets f
      JOIN landlords c ON c.id = f.landlord_id
      LEFT JOIN properties pr ON pr.id = f.property_id
     WHERE f.voided_at IS NULL
       AND COALESCE(pr.books_start_date, c.books_start_date) IS NOT NULL
       AND (f.funded_loan_id = NEW.id
            OR EXISTS (SELECT 1 FROM books_fixed_asset_funding y WHERE y.asset_id = f.id AND y.loan_id = NEW.id AND y.replaced_at IS NULL))
       AND (NEW.start_date < COALESCE(pr.books_start_date, c.books_start_date))
        <> (f.acquired_on  < COALESCE(pr.books_start_date, c.books_start_date))
     LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'This loan paid for the fixed asset "%", bought on %. Those books start on %, and the loan''s day cannot be on the other side of that day from the asset''s (the asset''s cost would count twice, or not at all). Change the asset''s day on the Fixed assets page first.',
        a.name, a.acquired_on, a.books_start_date
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- ── 4. prove the mirror is already true (no-op today) ───────────────────────
DO $$
DECLARE
  bad text;
BEGIN
  UPDATE landlords l
     SET books_start_date = sub.d
    FROM (SELECT p.landlord_id, min(p.books_start_date) AS d
            FROM properties p GROUP BY p.landlord_id) sub
   WHERE l.id = sub.landlord_id
     AND l.books_start_date IS DISTINCT FROM sub.d;

  SELECT string_agg(l.business_name || ' (company ' || COALESCE(l.books_start_date::text, 'none')
                    || ' vs earliest property ' || COALESCE(sub.d::text, 'none') || ')', '; ')
    INTO bad
    FROM landlords l
    JOIN (SELECT p.landlord_id, min(p.books_start_date) AS d
            FROM properties p GROUP BY p.landlord_id) sub ON sub.landlord_id = l.id
   WHERE l.books_start_date IS DISTINCT FROM sub.d;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'The company books-start mirror is still wrong after deriving it: %', bad;
  END IF;
END $$;
