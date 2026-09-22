-- S652 (Nic): the landlord TYPES the sale terms on the installment contract
-- and they become the record. Two boxes on the paper are derived from what he
-- typed — the final payment and the month it falls in — and need labels so the
-- template can place them and the signature can stamp them.
--
-- BACKFILL: none — new targets only.
ALTER TABLE lease_template_fields DROP CONSTRAINT IF EXISTS lease_template_fields_lease_column_check;
ALTER TABLE lease_template_fields ADD CONSTRAINT lease_template_fields_lease_column_check
  CHECK (lease_column IS NULL OR lease_column = ANY (ARRAY[
    'tenant_name', 'tenant_email', 'landlord_name', 'unit_number', 'property_name',
    'property_address', 'date_signed_day', 'date_signed_month', 'tenant_2_name', 'tenant_3_name',
    'tenant_4_name', 'occupant_names', 'sale_price', 'sale_down_payment', 'sale_financed_amount',
    'sale_monthly_payment', 'sale_term_months', 'sale_interest_rate', 'sale_first_payment_month', 'tenant_signature',
    'landlord_signature', 'tenant_initial', 'landlord_initial', 'date_signed', 'rent_amount',
    'start_date', 'end_date', 'security_deposit', 'move_in_first_month_rent', 'move_in_proration',
    'move_in_security_deposit', 'move_in_total_due', 'rent_due_day', 'lease_type', 'auto_renew',
    'auto_renew_mode', 'notice_days_required', 'expiration_notice_days', 'late_fee_grace_days', 'late_fee_initial_flat',
    'late_fee_initial_percent', 'late_fee_accrual_flat_daily', 'late_fee_accrual_flat_weekly', 'late_fee_accrual_flat_monthly', 'late_fee_accrual_percent_daily',
    'late_fee_accrual_percent_weekly', 'late_fee_accrual_percent_monthly', 'late_fee_cap_flat', 'late_fee_cap_percent', 'pet_deposit',
    'key_deposit', 'cleaning_deposit', 'utility_deposit', 'move_in_fee', 'cleaning_fee',
    'pet_fee', 'application_fee', 'amenity_fee', 'hoa_transfer_fee', 'lease_prep_fee',
    'pet_rent', 'parking_rent', 'storage_rent', 'amenity_fee_monthly', 'trash_fee',
    'pest_control_fee', 'technology_fee', 'last_month_rent', 'early_termination_fee', 'other_fee',
    'utility_water_responsibility', 'utility_gas_responsibility', 'utility_electric_responsibility', 'utility_sewer_responsibility', 'utility_trash_responsibility',
    'custom_text', 'sale_final_payment_amount', 'sale_final_payment_month'
  ]));
ALTER TABLE lease_document_fields DROP CONSTRAINT IF EXISTS lease_document_fields_lease_column_check;
ALTER TABLE lease_document_fields ADD CONSTRAINT lease_document_fields_lease_column_check
  CHECK (lease_column IS NULL OR lease_column = ANY (ARRAY[
    'tenant_name', 'tenant_email', 'landlord_name', 'unit_number', 'property_name',
    'property_address', 'date_signed_day', 'date_signed_month', 'tenant_2_name', 'tenant_3_name',
    'tenant_4_name', 'occupant_names', 'sale_price', 'sale_down_payment', 'sale_financed_amount',
    'sale_monthly_payment', 'sale_term_months', 'sale_interest_rate', 'sale_first_payment_month', 'tenant_signature',
    'landlord_signature', 'tenant_initial', 'landlord_initial', 'date_signed', 'rent_amount',
    'start_date', 'end_date', 'security_deposit', 'move_in_first_month_rent', 'move_in_proration',
    'move_in_security_deposit', 'move_in_total_due', 'rent_due_day', 'lease_type', 'auto_renew',
    'auto_renew_mode', 'notice_days_required', 'expiration_notice_days', 'late_fee_grace_days', 'late_fee_initial_flat',
    'late_fee_initial_percent', 'late_fee_accrual_flat_daily', 'late_fee_accrual_flat_weekly', 'late_fee_accrual_flat_monthly', 'late_fee_accrual_percent_daily',
    'late_fee_accrual_percent_weekly', 'late_fee_accrual_percent_monthly', 'late_fee_cap_flat', 'late_fee_cap_percent', 'pet_deposit',
    'key_deposit', 'cleaning_deposit', 'utility_deposit', 'move_in_fee', 'cleaning_fee',
    'pet_fee', 'application_fee', 'amenity_fee', 'hoa_transfer_fee', 'lease_prep_fee',
    'pet_rent', 'parking_rent', 'storage_rent', 'amenity_fee_monthly', 'trash_fee',
    'pest_control_fee', 'technology_fee', 'last_month_rent', 'early_termination_fee', 'other_fee',
    'utility_water_responsibility', 'utility_gas_responsibility', 'utility_electric_responsibility', 'utility_sewer_responsibility', 'utility_trash_responsibility',
    'custom_text', 'sale_final_payment_amount', 'sale_final_payment_month'
  ]));
