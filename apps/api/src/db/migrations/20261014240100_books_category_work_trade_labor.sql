-- 10/12 (Nic) — GAM BOOKS: A "WORK TRADE LABOR" CATEGORY FOR EXTRA HOURS PAID BY HAND
--
-- Nic, 10/12: paid extra work-trade hours are wages the landlord pays a
-- person, "Both" ways — by hand (Mark paid on the Work Trade page, a check or
-- cash) or through GAM Books (payroll or a contractor payment). Money out is
-- ONE record (L5): every dollar out is an Expense. Until now Mark paid wrote
-- nothing to the Expenses record, so hours paid by hand never reached the
-- books (services/ledgerProjectors LEDGER_SOURCE_TYPES_NOT_POSTED_YET said so).
-- Mark paid now records a PAID expense (services/workTradeBooksPay
-- recordWorkTradeHoursPaidByHand) under this starting category, on the chart's
-- Work-trade labor account (posting role work_trade_labor, 5190): to the
-- contractor vendor who is the work trader when the agreement pays them as a
-- 1099 contractor, a plain expense when they are W-2 paid outside payroll.
--
-- books_seed_categories() is re-created with the same rows as 20261014180000
-- plus this one (BOOKS_DEFAULT_EXPENSE_CATEGORIES in packages/shared/src/
-- booksMoneyOut.ts; services/booksCategories.test.ts holds the newest
-- definition and the shared list equal), and every company that already has
-- its starting categories gets it now. A company that already named a
-- category of its own "Work trade labor" keeps theirs (ON CONFLICT DO
-- NOTHING); Mark paid files under that one.
--
-- Expand-only; safe before the code ships (a new category nothing files under
-- until the code does). Idempotent.
-- Backfill: the SELECT at the end (every company with categories today).
-- Safe drop: re-create books_seed_categories() from 20261014180000; the
-- seeded rows are kept (a category is never removed — archive it).

SET LOCAL lock_timeout = '10s';

CREATE OR REPLACE FUNCTION books_seed_categories(p_landlord uuid) RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  n integer;
BEGIN
  IF p_landlord IS NULL THEN RETURN 0; END IF;
  INSERT INTO books_categories (landlord_id, direction, name, system_key, default_role, system_use)
  SELECT p_landlord, s.direction, s.name, s.key, s.role, s.system_use
    FROM (VALUES
      ('expense', 'maintenance',           'Maintenance',                'repairs_maintenance',    NULL::text, 1),
      ('expense', 'repairs',               'Repairs',                    'repairs_maintenance',    NULL, 2),
      ('expense', 'utilities',             'Utilities',                  'utilities_expense',      NULL, 3),
      ('expense', 'insurance',             'Insurance',                  'insurance',              NULL, 4),
      ('expense', 'property_tax',          'Property tax',               'property_taxes',         NULL, 5),
      ('expense', 'management',            'Management',                 'management_fees',        NULL, 6),
      ('expense', 'supplies',              'Supplies',                   'supplies',               NULL, 7),
      ('expense', 'landscaping',           'Landscaping',                'landscaping',            NULL, 8),
      ('expense', 'professional',          'Legal / professional',       'professional_fees',      NULL, 9),
      ('expense', 'mortgage_interest',     'Mortgage interest',          'mortgage_interest',      NULL, 10),
      ('expense', 'hoa',                   'HOA',                        'hoa_fees',               NULL, 11),
      ('expense', 'advertising',           'Advertising',                'advertising',            NULL, 12),
      ('expense', 'lot_rent',              'Lot rent',                   'lot_rent_expense',       NULL, 13),
      ('expense', 'bank_fees',             'Bank fees / charges',        'bank_fees',              NULL, 14),
      ('expense', 'other',                 'Other',                      'other_expenses',         NULL, 15),
      ('expense', 'pest_control',          'Pest control',               'pest_control',           NULL, 16),
      ('expense', 'accounting',            'Accounting and bookkeeping', 'accounting_fees',        NULL, 17),
      ('expense', 'software',              'Software and subscriptions', 'software_subscriptions', NULL, 18),
      ('expense', 'vehicle_travel',        'Vehicle and travel',         'vehicle_travel',         NULL, 19),
      ('expense', 'contractor_payments',   'Contractor payments',        'contractor_payments',    NULL, 20),
      ('expense', 'wages',                 'Wages paid outside payroll', 'payroll_expense',        NULL, 21),
      ('expense', 'owner_draw',            'Owner draw',                 'owner_draws',            NULL, 22),
      ('expense', 'payroll_take_home',     'Payroll: take-home pay',     'net_pay_payable',        'payroll', 23),
      ('expense', 'payroll_taxes',         'Payroll: taxes owed',        'payroll_liabilities',    'payroll', 24),
      ('expense', 'work_trade_labor',      'Work trade labor',           'work_trade_labor',       NULL, 25),
      ('income',  'laundry',               'Laundry',                    'laundry_vending',        NULL, 101),
      ('income',  'vending',               'Vending',                    'laundry_vending',        NULL, 102),
      ('income',  'storage',               'Storage',                    'storage_fees',           NULL, 103),
      ('income',  'utility_reimbursement', 'Utility reimbursement',      'utility_other',          NULL, 104),
      ('income',  'late_fees',             'Late fees',                  'late_fees',              NULL, 105),
      ('income',  'application_fees',      'Application fees',           'application_fees',       NULL, 106),
      ('income',  'pet_fees',              'Pet fees',                   'pet_fees',               NULL, 107),
      ('income',  'parking',               'Parking',                    'other_income',           NULL, 108),
      ('income',  'propane_fuel',          'Propane / fuel',             'utility_propane',        NULL, 109),
      ('income',  'insurance_claim',       'Insurance claim',            'other_income',           NULL, 110),
      ('income',  'tax_refund',            'Tax refund',                 'other_income',           NULL, 111),
      ('income',  'sale_proceeds',         'Sale proceeds',              'suspense',               NULL, 112),
      ('income',  'owner_contribution',    'Owner contribution',         'owner_equity',           NULL, 113),
      ('income',  'interest',              'Interest earned',            'interest_earned',        NULL, 114),
      ('income',  'other',                 'Other income',               'other_income',           NULL, 115)
    ) AS s(direction, key, name, role, system_use, ord)
   WHERE NOT EXISTS (SELECT 1 FROM books_categories c
                      WHERE c.landlord_id = p_landlord AND c.direction = s.direction AND c.system_key = s.key)
   ORDER BY s.ord
  -- A name the company already gave a category of its own keeps it; GAM's
  -- starting one of the same name is simply not added.
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;


COMMENT ON FUNCTION books_seed_categories(uuid) IS
  '10/12 (Nic, L5): adds GAM''s starting categories a company does not have yet (BOOKS_DEFAULT_*_CATEGORIES), Work trade labor included (20261014240100). Idempotent.';

-- Every company already seeded gets the new one now.
SELECT books_seed_categories(x.landlord_id)
  FROM (SELECT DISTINCT landlord_id FROM books_categories WHERE landlord_id IS NOT NULL) x;
