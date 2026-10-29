-- 10/12 (Nic) — EVERY MONEY TABLE KEEPS ITS HISTORY
--
-- GAM Books is becoming a real double-entry ledger that rebuilds from the
-- money records (gam-ledger-design-2026-10-12 §P1, M1). A rebuild can only be
-- trusted when every change to a money record is on file: what a row said
-- before an UPDATE, and the whole row when it was DELETEd. The change journal
-- (audit_row_changes, S550, AFTER UPDATE OR DELETE, function audit_row_change)
-- already covers payments, invoices, credit_uses, deposit_returns, utility
-- bills and the rest — but not the tables below, which were added later or
-- were missed. Production on 10/12: a receipt undo overwrote its status with
-- no record, a GAM charge was hard-deleted, held payout lines, owner shares,
-- register sales and refunds could all change with nothing kept.
--
-- Each table below was checked against schema.sql: it holds money (owed,
-- moved, held or earned), its id is a uuid (audit_row_change casts it), and it
-- had no audit trigger. The live row is the record of an INSERT (S550), so the
-- triggers fire AFTER UPDATE OR DELETE, the same as every other journaled
-- table. A no-op UPDATE writes nothing (audit_row_change compares the rows).
--
-- Left out on purpose: state caches recomputed from other rows
-- (float_account_state, reserve_fund_state, landlord_gam_balance_marks),
-- scheduling (payout_triggers), configuration (tenant_autopay, bank_connections,
-- rate tables, lease_template_conditional_fees) and logs that are themselves the
-- record (ach_monitoring_log, audit_log, admin_action_log). The test
-- (services/ledgerSourceFacts.test.ts) holds every table with a money column to
-- this list.
--
-- Tables another lane is creating right now (work_trade_extra_hours,
-- books_bill_payments, landlord_gam_charge_collections) get the same trigger
-- when they exist, so this file never fails on a table that was renamed or
-- not shipped yet.
--
-- audit_row_changes is never pruned (CLAUDE.md): it is how a rebuild explains
-- what changed.
--
-- No backfill possible: changes made before today were not journaled; the
-- live rows stand for them.
-- Safe drop: DROP TRIGGER audit_<table> ON <table> for each table below.

DO $$
DECLARE
  t text;
  money_tables text[] := ARRAY[
    -- tenant money in
    'tenant_remittances', 'remittance_applications', 'tenant_declared_deposits',
    'bank_deposit_allocations', 'lease_prepaid_credit_draws', 'paid_ahead_choices',
    'payment_reversals', 'connect_disputes', 'lease_rent_components',
    'lot_rent_charges', 'propane_fills', 'suspended_utility_charges',
    'utility_owner_use_absorptions', 'security_deposit_interest_accruals',
    'sublessor_credit_balances', 'work_trade_settlements',
    -- money GAM holds for the landlord, transfers and payouts
    'user_balance_ledger', 'held_payout_items', 'platform_transfer_intents',
    'connect_payouts', 'landlord_instant_margins',
    -- GAM charges to the landlord, and GAM's own book
    'landlord_gam_charges', 'landlord_gam_debits', 'platform_revenue_ledger', 'reserve_fund_ledger',
    'pm_monthly_fee_accruals', 'commission_accruals', 'screening_fee_accruals',
    'screening_prepayments', 'stripe_processing_costs',
    'flex_charge_statements', 'flex_charge_transactions',
    'flex_deposit_custody_charges', 'flexcredit_charges',
    -- register, pay links and stays
    'pos_transactions', 'pos_transaction_items', 'pos_refunds',
    'pos_eod_settlements', 'pos_held_payments', 'pos_reader_orders',
    'stay_payments', 'stay_refund_parts', 'stay_checkout_decisions',
    -- home sales
    'home_sale_contracts', 'home_sale_installments',
    -- money out, bank and the books
    'landlord_expenses', 'landlord_other_income', 'bank_transactions',
    'bank_reconciliations', 'journal_entries', 'journal_entry_lines',
    'payroll_run_lines', 'property_transfers',
    -- the business portal's money
    'business_invoice_payments', 'business_invoice_lines',
    'business_pos_transactions', 'business_pos_transaction_lines',
    'business_platform_fee_accruals'
  ];
  in_flight text[] := ARRAY[
    'work_trade_extra_hours', 'books_bill_payments', 'landlord_gam_charge_collections'
  ];
BEGIN
  -- A table that already has its journal trigger (another lane gave it one,
  -- or this file ran before) keeps it as it is.
  FOREACH t IN ARRAY money_tables LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = to_regclass('public.' || t) AND tgname = 'audit_' || t) THEN
      EXECUTE format(
        'CREATE TRIGGER %I AFTER DELETE OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION audit_row_change()',
        'audit_' || t, t);
    END IF;
  END LOOP;
  FOREACH t IN ARRAY in_flight LOOP
    IF to_regclass('public.' || t) IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = to_regclass('public.' || t) AND tgname = 'audit_' || t) THEN
      EXECUTE format(
        'CREATE TRIGGER %I AFTER DELETE OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION audit_row_change()',
        'audit_' || t, t);
    END IF;
  END LOOP;
END $$;
