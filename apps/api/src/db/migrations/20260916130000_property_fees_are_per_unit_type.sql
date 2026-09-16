-- S648 (Nic): property move-in fees come back, scoped to the UNIT TYPE, and
-- they pre-fill page 8 of the lease.
--
--   "We need to add all those fee types at the per property scoped per
--    property and per unit type. Obviously a pet deposit on an apartment is
--    gonna only apply to apartments. A pet deposit is not really gonna apply to
--    RVs because the tenants own those. So let's have property level fees but
--    have them scoped to unit types."
--
-- The table has held zero rows since the fee page was retired (S526), so the
-- new NOT NULL column needs no backfill. The signed lease is still what bills
-- (lease-is-law); this list is only where a new lease's boxes start from —
-- the same shape as property_unit_type_late_fees.
--
-- Also adds 'utility_deposit' as a fee type (S648, Nic: "add a utility deposit
-- as a charge type so you can set per property"), on both the property list
-- and lease_fees, matching FEE_TYPES in packages/shared.
ALTER TABLE property_fee_schedules
  ADD COLUMN unit_type text NOT NULL;

ALTER TABLE property_fee_schedules
  ADD CONSTRAINT property_fee_schedules_unit_type_check CHECK (unit_type = ANY (ARRAY[
    'apartment', 'single_family', 'rv_spot', 'campsite', 'mobile_home', 'hotel_room',
    'storage', 'parking', 'boat_slip', 'land_lot', 'commercial']));

ALTER TABLE property_fee_schedules
  DROP CONSTRAINT property_fee_schedules_property_id_fee_type_slot_index_key;
ALTER TABLE property_fee_schedules
  ADD CONSTRAINT property_fee_schedules_property_unit_type_fee_slot_key
  UNIQUE (property_id, unit_type, fee_type, slot_index);

ALTER TABLE property_fee_schedules DROP CONSTRAINT property_fee_schedules_fee_type_check;
ALTER TABLE property_fee_schedules ADD CONSTRAINT property_fee_schedules_fee_type_check
  CHECK (fee_type = ANY (ARRAY['security_deposit', 'pet_deposit', 'key_deposit', 'cleaning_deposit',
    'utility_deposit', 'move_in_fee', 'cleaning_fee', 'pet_fee', 'application_fee', 'amenity_fee',
    'hoa_transfer_fee', 'lease_prep_fee', 'pet_rent', 'parking_rent', 'storage_rent',
    'amenity_fee_monthly', 'trash_fee', 'pest_control_fee', 'technology_fee', 'last_month_rent',
    'early_termination_fee', 'other_fee']));

ALTER TABLE lease_fees DROP CONSTRAINT lease_fees_fee_type_check;
ALTER TABLE lease_fees ADD CONSTRAINT lease_fees_fee_type_check
  CHECK (fee_type = ANY (ARRAY['security_deposit', 'pet_deposit', 'key_deposit', 'cleaning_deposit',
    'utility_deposit', 'move_in_fee', 'cleaning_fee', 'pet_fee', 'application_fee', 'amenity_fee',
    'hoa_transfer_fee', 'lease_prep_fee', 'pet_rent', 'parking_rent', 'storage_rent',
    'amenity_fee_monthly', 'trash_fee', 'pest_control_fee', 'technology_fee', 'last_month_rent',
    'early_termination_fee', 'other_fee']));

-- The two field tables constrain lease_column to LEASE_COLUMNS; add utility_deposit.
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

COMMENT ON COLUMN property_fee_schedules.unit_type IS
  'S648: which kind of unit at this property the fee applies to. A new lease''s fee boxes pre-fill from the rows matching its unit''s type.';
