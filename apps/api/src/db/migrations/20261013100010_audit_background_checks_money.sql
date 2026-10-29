-- 10/12 (Nic) — GAM'S SCREENING MONEY KEEPS ITS HISTORY, WITHOUT THE APPLICANT'S FILE
--
-- 20261013100000_audit_money_tables journaled every table that holds money,
-- and services/ledgerSourceFacts.test.ts holds every table with a money column
-- to it. That test only looked at a handful of column names (amount, total,
-- ...), so it could not see background_checks, which holds GAM's screening
-- money: amount_charged (what the applicant paid) and platform_net (what GAM
-- keeps). Both are changed in place with no journal — a refund is stamped on
-- the row (services/backgroundRefund), and platform_net is rewritten when a
-- stay's prepaid check is used (services/stayTerms) and when GAM's revenue is
-- trued up (services/platformRevenue). A ledger rebuild could not say what
-- either said before.
--
-- The row also carries the applicant's whole file — name, date of birth, the
-- encrypted SSN, address, income, documents, the screening result. The
-- journal is never pruned (CLAUDE.md), so copying the row into it would keep
-- that file forever. So this journals ONLY the money and who it belongs to:
-- a new trigger function, audit_row_change_columns(column, ...), writes the
-- same audit_row_changes row audit_row_change does, but with only the columns
-- named in the trigger's arguments, and only when one of them changed. A
-- whitelist, not a redaction list: a personal column added later is never
-- journaled by accident.
--
-- Journaled columns: id, landlord_id, user_id, tenant_id, unit_id,
-- property_id, pool_entry_id, amount_charged, platform_net,
-- applicant_payment_intent_id, stripe_refund_id, refunded_at, created_at.
--
-- The money-column test now looks at every numeric column whose name says
-- money (%amount%, %net%, %fee%, %total%, %price%, %paid%). These tables have
-- such a column and are left out on purpose (named in the test, with why):
--   allocation_splits                append-only (a trigger refuses UPDATE and DELETE)
--   ach_monitoring_log(_archive)     logs that are themselves the record
--   pos_price_history                a log that is itself the record
--   lease_template_conditional_fees, property_utility_rates,
--   state_application_fee_caps, state_deposit_interest_rates   configuration and rate tables
--   scheduled_lease_changes          a change waiting to be made (the lease it makes is journaled)
--   sublessee_invitations            an invitation (subleasing is shelved)
--   business_quote_lines, business_recurring_invoice_lines,
--   business_work_order_lines        quotes, templates and work in progress — what is billed
--                                    is copied to business_invoice_lines (journaled)
--   pos_session_items                a register cart before the sale (pos_transaction_items is journaled)
--   pos_purchase_order_items         an order to a supplier, not money moved (money out is an expense)
--   utility_reading_runs             a summary of the bills a run made (utility_bills is journaled)
--   fitness_milestones, generated_routes   not money (pounds, miles)
--
-- No backfill possible: changes made before this were not journaled.
-- Safe drop: DROP TRIGGER audit_background_checks ON background_checks;
-- DROP FUNCTION audit_row_change_columns().

CREATE OR REPLACE FUNCTION audit_row_change_columns() RETURNS trigger AS $$
DECLARE
  keep text[] := TG_ARGV;
  old_j jsonb;
  new_j jsonb;
BEGIN
  SELECT COALESCE(jsonb_object_agg(e.key, e.value), '{}'::jsonb) INTO old_j
    FROM jsonb_each(to_jsonb(OLD)) e WHERE e.key = ANY (keep);
  IF TG_OP = 'UPDATE' THEN
    SELECT COALESCE(jsonb_object_agg(e.key, e.value), '{}'::jsonb) INTO new_j
      FROM jsonb_each(to_jsonb(NEW)) e WHERE e.key = ANY (keep);
    IF old_j = new_j THEN RETURN NEW; END IF;  -- nothing journaled changed
    INSERT INTO audit_row_changes (table_name, row_id, op, old_row, new_row)
    VALUES (TG_TABLE_NAME, (to_jsonb(OLD)->>'id')::uuid, 'UPDATE', old_j, new_j);
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    INSERT INTO audit_row_changes (table_name, row_id, op, old_row, new_row)
    VALUES (TG_TABLE_NAME, (to_jsonb(OLD)->>'id')::uuid, 'DELETE', old_j, NULL);
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION audit_row_change_columns() IS
  '10/12 (Nic, ledger P1 review): audit_row_change, keeping only the columns named in the trigger arguments (a whitelist) — for money rows that also carry a personal file (background_checks).';

DROP TRIGGER IF EXISTS audit_background_checks ON background_checks;
CREATE TRIGGER audit_background_checks
  AFTER DELETE OR UPDATE ON background_checks
  FOR EACH ROW EXECUTE FUNCTION audit_row_change_columns(
    'id', 'landlord_id', 'user_id', 'tenant_id', 'unit_id', 'property_id', 'pool_entry_id',
    'amount_charged', 'platform_net', 'applicant_payment_intent_id', 'stripe_refund_id', 'refunded_at', 'created_at');
