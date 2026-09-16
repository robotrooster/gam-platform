-- S648 (Nic, DIRECTIVE): page 8 of the lease is the move-in invoice.
--
--   "First month's rent, proration... those should be changeable because
--    landlords [run move-in specials]. The total should still calculate
--    everything from those and not be typable." "Page eight security deposit
--    copies page two so they can't disagree." Onboarding residents: $0.
--
-- Four page 8 boxes were tagged to nothing, so billing never read them. That is
-- how Martin Alvarado (MV RV 34) and Clay Simpson (MV RV 25) had $495 on page 8,
-- $589 on page 2, and were billed $589.
--
--  * leases.move_in_first_month_rent / move_in_proration — what page 8 says the
--    move-in invoice charges for rent. NULL = an older lease; billing keeps its
--    original rule. No backfill.
--  * properties.move_in_collects_next_period — whether a mid-month move-in pays
--    the next full month up front (page 8 then starts with it filled in).
--    Default FALSE = today's behaviour. Property-wide on purpose: Nic worried a
--    per-tenant choice of how much to take up front could look discriminatory.
--  * two new DISPLAY tags, move_in_security_deposit and move_in_total_due,
--    which the system fills and locks.
--  * the untagged page 8 boxes on existing templates are tagged by label.
ALTER TABLE leases
  ADD COLUMN IF NOT EXISTS move_in_first_month_rent numeric(10,2),
  ADD COLUMN IF NOT EXISTS move_in_proration numeric(10,2);
ALTER TABLE leases
  ADD CONSTRAINT leases_move_in_amounts_nonneg
  CHECK (COALESCE(move_in_first_month_rent, 0) >= 0 AND COALESCE(move_in_proration, 0) >= 0);

ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS move_in_collects_next_period boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN properties.move_in_collects_next_period IS
  'S648: TRUE = a new tenant moving in mid-cycle pays the proration AND the next full month at move-in (that regular bill is then skipped). FALSE = proration only; the next month bills on the regular cycle.';

ALTER TABLE lease_template_fields DROP CONSTRAINT lease_template_fields_lease_column_check;
ALTER TABLE lease_template_fields ADD CONSTRAINT lease_template_fields_lease_column_check
  CHECK (lease_column IS NULL OR lease_column = ANY (ARRAY[
    'tenant_name',
    'tenant_email',
    'landlord_name',
    'unit_number',
    'property_name',
    'property_address',
    'date_signed_day',
    'date_signed_month',
    'tenant_2_name',
    'tenant_3_name',
    'tenant_4_name',
    'occupant_names',
    'sale_price',
    'sale_down_payment',
    'sale_financed_amount',
    'sale_monthly_payment',
    'sale_term_months',
    'sale_interest_rate',
    'sale_first_payment_month',
    'tenant_signature',
    'landlord_signature',
    'tenant_initial',
    'landlord_initial',
    'date_signed',
    'rent_amount',
    'start_date',
    'end_date',
    'security_deposit',
    'move_in_first_month_rent',
    'move_in_proration',
    'move_in_security_deposit',
    'move_in_total_due',
    'rent_due_day',
    'lease_type',
    'auto_renew',
    'auto_renew_mode',
    'notice_days_required',
    'expiration_notice_days',
    'late_fee_grace_days',
    'late_fee_initial_flat',
    'late_fee_initial_percent',
    'late_fee_accrual_flat_daily',
    'late_fee_accrual_flat_weekly',
    'late_fee_accrual_flat_monthly',
    'late_fee_accrual_percent_daily',
    'late_fee_accrual_percent_weekly',
    'late_fee_accrual_percent_monthly',
    'late_fee_cap_flat',
    'late_fee_cap_percent',
    'pet_deposit',
    'key_deposit',
    'cleaning_deposit',
    'utility_deposit',
    'move_in_fee',
    'cleaning_fee',
    'pet_fee',
    'application_fee',
    'amenity_fee',
    'hoa_transfer_fee',
    'lease_prep_fee',
    'pet_rent',
    'parking_rent',
    'storage_rent',
    'amenity_fee_monthly',
    'trash_fee',
    'pest_control_fee',
    'technology_fee',
    'last_month_rent',
    'early_termination_fee',
    'other_fee',
    'utility_water_responsibility',
    'utility_gas_responsibility',
    'utility_electric_responsibility',
    'utility_sewer_responsibility',
    'utility_trash_responsibility',
    'custom_text']));
ALTER TABLE lease_document_fields DROP CONSTRAINT lease_document_fields_lease_column_check;
ALTER TABLE lease_document_fields ADD CONSTRAINT lease_document_fields_lease_column_check
  CHECK (lease_column IS NULL OR lease_column = ANY (ARRAY[
    'tenant_name',
    'tenant_email',
    'landlord_name',
    'unit_number',
    'property_name',
    'property_address',
    'date_signed_day',
    'date_signed_month',
    'tenant_2_name',
    'tenant_3_name',
    'tenant_4_name',
    'occupant_names',
    'sale_price',
    'sale_down_payment',
    'sale_financed_amount',
    'sale_monthly_payment',
    'sale_term_months',
    'sale_interest_rate',
    'sale_first_payment_month',
    'tenant_signature',
    'landlord_signature',
    'tenant_initial',
    'landlord_initial',
    'date_signed',
    'rent_amount',
    'start_date',
    'end_date',
    'security_deposit',
    'move_in_first_month_rent',
    'move_in_proration',
    'move_in_security_deposit',
    'move_in_total_due',
    'rent_due_day',
    'lease_type',
    'auto_renew',
    'auto_renew_mode',
    'notice_days_required',
    'expiration_notice_days',
    'late_fee_grace_days',
    'late_fee_initial_flat',
    'late_fee_initial_percent',
    'late_fee_accrual_flat_daily',
    'late_fee_accrual_flat_weekly',
    'late_fee_accrual_flat_monthly',
    'late_fee_accrual_percent_daily',
    'late_fee_accrual_percent_weekly',
    'late_fee_accrual_percent_monthly',
    'late_fee_cap_flat',
    'late_fee_cap_percent',
    'pet_deposit',
    'key_deposit',
    'cleaning_deposit',
    'utility_deposit',
    'move_in_fee',
    'cleaning_fee',
    'pet_fee',
    'application_fee',
    'amenity_fee',
    'hoa_transfer_fee',
    'lease_prep_fee',
    'pet_rent',
    'parking_rent',
    'storage_rent',
    'amenity_fee_monthly',
    'trash_fee',
    'pest_control_fee',
    'technology_fee',
    'last_month_rent',
    'early_termination_fee',
    'other_fee',
    'utility_water_responsibility',
    'utility_gas_responsibility',
    'utility_electric_responsibility',
    'utility_sewer_responsibility',
    'utility_trash_responsibility',
    'custom_text']));

-- Tag the page 8 boxes on every template that prints them. Only boxes that are
-- untagged today, only on the page that holds the move-in list (the one with a
-- Rent pre-payment box), matched by their exact label.
WITH p8 AS (
  SELECT DISTINCT template_id, page FROM lease_template_fields WHERE lease_column = 'last_month_rent'
)
UPDATE lease_template_fields f
   SET lease_column = CASE f.label
         WHEN 'First month''s rent' THEN 'move_in_first_month_rent'
         WHEN 'Proration'           THEN 'move_in_proration'
         WHEN 'Security deposit'    THEN 'move_in_security_deposit'
         WHEN 'Total due'           THEN 'move_in_total_due' END
  FROM p8
 WHERE f.template_id = p8.template_id AND f.page = p8.page
   AND f.lease_column IS NULL
   AND f.label IN ('First month''s rent', 'Proration', 'Security deposit', 'Total due');
