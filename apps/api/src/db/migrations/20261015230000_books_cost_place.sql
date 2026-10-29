-- 10/13 (Nic) — WHERE A COST GOES IS PICKED WHEN IT IS LOGGED, NEVER A SETTING
--
-- Nic, 10/13: "each expense is chosen on the split or specific unit or
-- property at the time of logging. there should never be a default setting to
-- apply expenses." And: "except gams charge all those costs get logged by a
-- person or they wont show as itemized in the books."
--
-- The Books settings page's "Costs that are no one property's" choice
-- (landlords.books_company_costs_method, with the Company-column default and
-- books_company_costs_from of 20261015190000) is gone from the product: no
-- projector, route or page reads it any more. Instead every record a person
-- logs that carries a cost says, when it is logged, where that cost goes —
-- `cost_place` (BOOKS_COST_PLACES in packages/shared booksLedger):
--
--   split_by_units  split across the company's properties by how many units
--                   each had on the cost's day (company level when it had none)
--   property        one property (property_id)
--   unit            one unit (unit_id; property_id is that unit's property)
--
-- on
--   landlord_expenses   the expense or bill (property_id / unit_id were already
--                       there; a split one names neither)
--   payroll_runs        the gross wages and the employer's taxes of the run
--                       (property_id / unit_id are new)
--   books_loans         each payment's interest (property_id was already there:
--                       the loan's other lines stay on it; unit_id is new)
--   books_fixed_assets  each month's depreciation (property_id was already
--                       there: the cost and accumulated depreciation stay on
--                       it; unit_id is new)
--
-- The routes refuse a new record without one (the forms ask). GAM's own
-- company-wide charges — the only costs nobody logs (a $6 transfer cost, an
-- instant payout's fee, a card reader piece on no property) — go to the
-- Company column (property NULL), no choice involved.
--
-- NULL stays allowed: a record logged before 10/13 keeps posting as it posted
-- (its property, else the Company column), and a bill GAM makes for another
-- record (a payroll run's take-home pay or taxes, a payout split's manager's
-- cut) moves money owed and places no cost. The checks below hold each place
-- to the property and unit it names; a unit's property and the company's
-- ownership of both are the routes' to check.
--
-- The capture: cost_place (and the new property_id / unit_id) are appended to
-- each table's capture list (LEDGER_CAPTURE_COLUMNS in packages/shared, same
-- order), so a change re-posts the record — for a loan, every payment's
-- interest too. books_fixed_assets is re-installed with its funding lines in
-- 20261015230100.
--
-- Expand-only: nullable columns, checks every existing row meets (production
-- has no expense, payroll run, loan or fixed asset yet — counted read-only on
-- 10/13), the captures re-installed (bodies only — ledger_install_capture).
-- No backfill needed. landlords.books_company_costs_method and
-- books_company_costs_from stay (contract later). Idempotent.
-- Safe drop: the checks, the columns (after re-installing the captures as
-- 20261014180500 / 20261014200100 / 20261014210100 left them).

SET LOCAL lock_timeout = '10s';

ALTER TABLE landlord_expenses ADD COLUMN IF NOT EXISTS cost_place text;
ALTER TABLE payroll_runs ADD COLUMN IF NOT EXISTS cost_place text;
ALTER TABLE payroll_runs ADD COLUMN IF NOT EXISTS property_id uuid REFERENCES properties(id);
-- No key on a run's unit: a unit is never removed (it is retired), the route
-- checks it is the company's, and a key would only make clearing payroll runs
-- and units order-dependent.
ALTER TABLE payroll_runs ADD COLUMN IF NOT EXISTS unit_id uuid;
ALTER TABLE books_loans ADD COLUMN IF NOT EXISTS cost_place text;
ALTER TABLE books_loans ADD COLUMN IF NOT EXISTS unit_id uuid REFERENCES units(id);
ALTER TABLE books_fixed_assets ADD COLUMN IF NOT EXISTS cost_place text;
ALTER TABLE books_fixed_assets ADD COLUMN IF NOT EXISTS unit_id uuid REFERENCES units(id);

-- A place names what it is: a unit (and its property), a property and no
-- unit, or neither when split. An expense keeps both on a unit (its property
-- is the unit's, createLandlordExpense).
ALTER TABLE landlord_expenses DROP CONSTRAINT IF EXISTS landlord_expenses_cost_place_check;
ALTER TABLE landlord_expenses ADD CONSTRAINT landlord_expenses_cost_place_check
  CHECK (cost_place IS NULL
         OR (cost_place = 'unit' AND unit_id IS NOT NULL)
         OR (cost_place = 'property' AND property_id IS NOT NULL AND unit_id IS NULL)
         OR (cost_place = 'split_by_units' AND property_id IS NULL AND unit_id IS NULL));

-- A payroll run names a property or unit only with its place, and only for a
-- landlord company's run (a business's books have no properties).
ALTER TABLE payroll_runs DROP CONSTRAINT IF EXISTS payroll_runs_cost_place_check;
ALTER TABLE payroll_runs ADD CONSTRAINT payroll_runs_cost_place_check
  CHECK ((cost_place IS NULL AND property_id IS NULL AND unit_id IS NULL)
         OR (landlord_id IS NOT NULL
             AND ((cost_place = 'unit' AND unit_id IS NOT NULL AND property_id IS NOT NULL)
                  OR (cost_place = 'property' AND property_id IS NOT NULL AND unit_id IS NULL)
                  OR (cost_place = 'split_by_units' AND property_id IS NULL AND unit_id IS NULL))));

-- A loan or an asset logged before 10/13 may name a property with no place.
ALTER TABLE books_loans DROP CONSTRAINT IF EXISTS books_loans_cost_place_check;
ALTER TABLE books_loans ADD CONSTRAINT books_loans_cost_place_check
  CHECK ((cost_place IS NULL AND unit_id IS NULL)
         OR (landlord_id IS NOT NULL
             AND ((cost_place = 'unit' AND unit_id IS NOT NULL AND property_id IS NOT NULL)
                  OR (cost_place = 'property' AND property_id IS NOT NULL AND unit_id IS NULL)
                  OR (cost_place = 'split_by_units' AND property_id IS NULL AND unit_id IS NULL))));

ALTER TABLE books_fixed_assets DROP CONSTRAINT IF EXISTS books_fixed_assets_cost_place_check;
ALTER TABLE books_fixed_assets ADD CONSTRAINT books_fixed_assets_cost_place_check
  CHECK ((cost_place IS NULL AND unit_id IS NULL)
         OR (landlord_id IS NOT NULL
             AND ((cost_place = 'unit' AND unit_id IS NOT NULL AND property_id IS NOT NULL)
                  OR (cost_place = 'property' AND property_id IS NOT NULL AND unit_id IS NULL)
                  OR (cost_place = 'split_by_units' AND property_id IS NULL AND unit_id IS NULL))));

COMMENT ON COLUMN landlord_expenses.cost_place IS
  '10/13 (Nic): where this cost goes, picked when it was logged — split_by_units (across the company''s properties by units on its day; property and unit NULL), property, or unit. NULL: logged before 10/13 (its property, else the Company column) or a bill GAM made for another record that places no cost. BOOKS_COST_PLACES.';
COMMENT ON COLUMN payroll_runs.cost_place IS
  '10/13 (Nic): where the run''s gross wages and the employer''s taxes go, picked when the run is logged — split_by_units, property (property_id) or unit (unit_id). Required to approve a landlord company''s run. NULL: a run approved before 10/13 (the Company column) or a business''s run. BOOKS_COST_PLACES.';
COMMENT ON COLUMN payroll_runs.property_id IS
  '10/13 (Nic): the property the run''s wages and employer taxes go to (cost_place property, or the unit''s property for unit).';
COMMENT ON COLUMN payroll_runs.unit_id IS
  '10/13 (Nic): the unit the run''s wages and employer taxes go to (cost_place unit).';
COMMENT ON COLUMN books_loans.cost_place IS
  '10/13 (Nic): where each payment''s interest goes, picked when the loan is logged — split_by_units, property (property_id) or unit (unit_id). NULL: a loan logged before 10/13 (its property, else the Company column). BOOKS_COST_PLACES.';
COMMENT ON COLUMN books_loans.unit_id IS
  '10/13 (Nic): the unit each payment''s interest goes to (cost_place unit; property_id is that unit''s property).';
COMMENT ON COLUMN books_fixed_assets.cost_place IS
  '10/13 (Nic): where each month''s depreciation goes, picked when the asset is logged — split_by_units, property (property_id) or unit (unit_id). NULL: an asset logged before 10/13 (its property, else the Company column). BOOKS_COST_PLACES.';
COMMENT ON COLUMN books_fixed_assets.unit_id IS
  '10/13 (Nic): the unit each month''s depreciation goes to (cost_place unit; property_id is that unit''s property).';
COMMENT ON COLUMN landlords.books_company_costs_method IS
  'RETIRED 10/13 (Nic): "there should never be a default setting to apply expenses." Nothing reads it; where a cost goes is picked on each record (cost_place). Kept until a contract migration drops it.';

CREATE INDEX IF NOT EXISTS payroll_runs_unit ON payroll_runs (unit_id) WHERE unit_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS payroll_runs_property ON payroll_runs (property_id) WHERE property_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS books_loans_unit ON books_loans (unit_id) WHERE unit_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS books_fixed_assets_unit ON books_fixed_assets (unit_id) WHERE unit_id IS NOT NULL;

-- ── The ledger capture (LEDGER_CAPTURE_COLUMNS in packages/shared) ──────────
-- As 20261014180500, 20261014200100 and 20261014210100 installed them, plus
-- the new columns.
SELECT ledger_install_capture('landlord_expenses',
  ARRAY['landlord_id', 'property_id', 'unit_id', 'category', 'amount', 'expense_date', 'is_common', 'allocate_per_unit',
        'status', 'voided_at', 'utility_type', 'vendor', 'bank_transaction_id',
        'category_id', 'vendor_id', 'allocation_split_id',
        'cost_place'],
  $k$SELECT 'expense'::text, r.id::text, r.landlord_id
      UNION ALL SELECT 'expense_payment', p.id::text, p.landlord_id FROM landlord_expense_payments p WHERE p.expense_id = r.id$k$);

SELECT ledger_install_capture('payroll_runs',
  ARRAY['landlord_id', 'business_id', 'pay_date', 'status', 'total_gross', 'total_federal_tax', 'total_state_tax',
        'total_ss', 'total_medicare', 'total_net', 'approved_at', 'voided_at',
        'total_employer_ss', 'total_employer_medicare', 'total_futa', 'total_suta',
        'cost_place', 'property_id', 'unit_id'],
  $k$SELECT 'payroll_run'::text, r.id::text, COALESCE(r.landlord_id, r.business_id)$k$);

SELECT ledger_install_capture('books_loans',
  ARRAY['landlord_id', 'business_id', 'property_id', 'name', 'original_amount', 'start_date',
        'funded_to', 'funded_bank_connection_id', 'opening_balance', 'opening_escrow', 'voided_at',
        'funded_bank_transaction_id',
        'cost_place', 'unit_id'],
  $k$SELECT 'loan'::text, r.id::text, COALESCE(r.landlord_id, r.business_id)
      UNION ALL SELECT 'loan_payment', p.id::text, COALESCE(r.landlord_id, r.business_id)
                  FROM books_loan_payments p WHERE p.loan_id = r.id$k$);
