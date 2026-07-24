-- S550 final data-completeness pass (Nic: "100% sure?"). Mechanical
-- enumeration of every table WITHOUT an audit trigger, classified:
--   * append-only ledgers/logs/events (credit_events hash-chained, *_log,
--     *_archive, email_send_log, notifications, ledgers, sequences,
--     pos_price_history, pos_inventory_log, snapshots, product_events):
--     immutable by nature — journaling would double-write.
--   * reference catalogs (state_* law/tax/rate tables): update-never rule.
--   * secret/token-bearing (user_bank_accounts, totp recovery codes, all
--     *_invitations / *_tokens, guest access tokens): excluded by design.
--   * side apps (fitness_*): not platform asset data.
--   * background_checks / adverse_action_notices: excluded pending a PII
--     review (report payloads) — revisit before journaling.
--   * everything else that MUTATES: journaled below. This is the closing
--     set.
-- Standing rule (also in OAK_PARK_LAUNCH.md): every future table ships
-- with a journal trigger unless it's append-only/secret/catalog.
-- No backfill possible: history starts now.

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    -- e-sign + lease-attached entities
    'lease_documents', 'lease_document_signers', 'lease_document_fields',
    'lease_templates', 'lease_template_fields',
    'lease_occupants', 'lease_pets', 'lease_vehicles', 'rvs', 'mobile_homes',
    'liability_insurance_policies', 'emergency_contacts', 'tenant_identifications',
    'lease_renewal_requests', 'lease_termination_requests', 'lease_prepaid_credits',
    'lease_utility_assignments', 'lease_utility_responsibilities',
    'pending_tenant_intents',
    -- applications + screening surface (sans bg-check payloads)
    'unit_applications', 'application_pool', 'tenant_questionnaires',
    -- PM companies
    'pm_companies', 'pm_fee_plans', 'pm_staff', 'pm_property_invitations',
    -- business portal suite
    'businesses', 'business_users', 'business_customers', 'business_invoices',
    'business_quotes', 'business_work_orders', 'business_inventory_items',
    'business_recurring_invoice_schedules', 'business_bookable_services',
    -- POS config + lifecycle (transactions/refunds are append; config mutates)
    'pos_sessions', 'pos_customers', 'pos_categories', 'pos_discounts',
    'pos_tax_rates', 'pos_purchase_orders', 'pos_vendors', 'pos_item_variants',
    -- operations
    'appointments', 'scheduled_maintenance', 'recurring_schedules',
    'service_interruptions', 'common_area_reservations',
    'booking_change_requests', 'unit_booking_waitlists',
    'work_trade_agreements', 'shifts', 'daily_tasks', 'purchase_requests',
    'contractors', 'parts_inventory', 'propane_fill_installments',
    'unit_inspection_items',
    -- money-adjacent mutable state
    'flex_deposit_installments', 'flexpay_advances', 'flexpay_inquiries',
    'otp_advances', 'disbursements', 'monthly_fee_accruals',
    'platform_fee_accruals', 'landlord_platform_fee_overrides',
    'platform_fee_config', 'platform_processing_rates',
    'property_fee_schedules', 'property_faqs', 'property_inquiries',
    'sales_leads', 'notification_preferences',
    -- bookkeeping core
    'books_accounts', 'books_employees', 'books_bills', 'books_transactions',
    'books_contractors', 'books_vendors', 'payroll_runs'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I AFTER UPDATE OR DELETE ON %I
         FOR EACH ROW EXECUTE FUNCTION audit_row_change()',
      'audit_' || t, t);
  END LOOP;
END $$;
