-- 10/30 (Nic): REMOVE the 'monthly' late-fee cadence.
--
-- WHY. A late fee is one of two things: a one-time fee when the bill goes past
-- grace, or an ongoing fee that keeps accruing while it stays unpaid. 'monthly'
-- was filed as an ongoing cadence, but what a monthly late fee actually means is
-- ONE fee on that bill — and if rent still isn't paid when the next invoice goes
-- out, that invoice carries its own fee. That is exactly what a one-time fee with
-- nothing in the ongoing box already does, proven against the engine before this
-- was cut: three consecutive unpaid bills each took exactly one fee, each on its
-- own grace end, and a second nightly run added nothing. So the cadence was a
-- duplicate of a thing that already worked.
--
-- It was also the ONLY cadence carrying calendar math. Months differ in length,
-- so a fee on the 31st has to clamp back to the 30th in June and back out to the
-- 31st in July, and every anchor bug in the late-fee engine came out of that
-- clamping. Day and week are plain day arithmetic and cannot drift.
--
-- Nic kept 'weekly': it recurs on the same bill the way daily does, with no
-- clamping, and how landlords invoice varies by state and on the business portal.
--
-- NO BACKFILL NEEDED. Nothing stored 'monthly' at any level when this was cut —
-- verified zero rows across leases, property_unit_type_late_fees,
-- utility_service_agreements, home_sale_contracts, and zero lease_document_fields
-- / lease_template_fields placing either monthly paper field. This is contract-
-- only: the writers were narrowed in the same batch, so nothing can send it.
--
-- The two monthly PAPER fields go with it. They were meant to express a one-time
-- fee as flat dollars or a percent of rent, and late_fee_initial_flat /
-- late_fee_initial_percent already do exactly that, so nothing is lost on a lease.

-- ── the stored cadence: daily | weekly ──────────────────────────────────────
ALTER TABLE leases
  DROP CONSTRAINT IF EXISTS leases_late_fee_accrual_period_check;
ALTER TABLE leases
  ADD CONSTRAINT leases_late_fee_accrual_period_check
  CHECK (late_fee_accrual_period = ANY (ARRAY['daily'::text, 'weekly'::text]));

ALTER TABLE property_unit_type_late_fees
  DROP CONSTRAINT IF EXISTS property_unit_type_late_fees_late_fee_accrual_period_check;
ALTER TABLE property_unit_type_late_fees
  ADD CONSTRAINT property_unit_type_late_fees_late_fee_accrual_period_check
  CHECK (late_fee_accrual_period IS NULL
         OR late_fee_accrual_period = ANY (ARRAY['daily'::text, 'weekly'::text]));

ALTER TABLE utility_service_agreements
  DROP CONSTRAINT IF EXISTS usa_late_fee_accrual_period_check;
ALTER TABLE utility_service_agreements
  ADD CONSTRAINT usa_late_fee_accrual_period_check
  CHECK (late_fee_accrual_period IS NULL
         OR late_fee_accrual_period = ANY (ARRAY['daily'::text, 'weekly'::text]));

ALTER TABLE home_sale_contracts
  DROP CONSTRAINT IF EXISTS home_sale_contracts_late_fee_accrual_period_check;
ALTER TABLE home_sale_contracts
  ADD CONSTRAINT home_sale_contracts_late_fee_accrual_period_check
  CHECK (late_fee_accrual_period IS NULL
         OR late_fee_accrual_period = ANY (ARRAY['daily'::text, 'weekly'::text]));

-- ── the lease paper: the two monthly accrual fields are gone ────────────────
ALTER TABLE lease_document_fields
  DROP CONSTRAINT IF EXISTS lease_document_fields_lease_column_check;
ALTER TABLE lease_document_fields
  ADD CONSTRAINT lease_document_fields_lease_column_check
  CHECK (lease_column IS NULL OR lease_column = ANY (ARRAY[
    'tenant_name', 'tenant_email', 'landlord_name', 'unit_number', 'property_name',
    'property_address', 'date_signed_day', 'date_signed_month', 'tenant_2_name',
    'tenant_3_name', 'tenant_4_name', 'occupant_names', 'sale_price', 'sale_down_payment',
    'sale_financed_amount', 'sale_monthly_payment', 'sale_term_months', 'sale_interest_rate',
    'sale_first_payment_month', 'tenant_signature', 'landlord_signature', 'tenant_initial',
    'landlord_initial', 'date_signed', 'rent_amount', 'start_date', 'end_date',
    'security_deposit', 'move_in_first_month_rent', 'move_in_proration',
    'move_in_security_deposit', 'move_in_total_due', 'rent_due_day', 'lease_type', 'auto_renew',
    'auto_renew_mode', 'notice_days_required', 'expiration_notice_days', 'late_fee_grace_days',
    'late_fee_initial_flat', 'late_fee_initial_percent', 'late_fee_accrual_flat_daily',
    'late_fee_accrual_flat_weekly', 'late_fee_accrual_percent_daily',
    'late_fee_accrual_percent_weekly', 'late_fee_cap_flat', 'late_fee_cap_percent',
    'pet_deposit', 'key_deposit', 'cleaning_deposit', 'utility_deposit', 'move_in_fee',
    'cleaning_fee', 'pet_fee', 'application_fee', 'amenity_fee', 'hoa_transfer_fee',
    'lease_prep_fee', 'pet_rent', 'parking_rent', 'storage_rent', 'amenity_fee_monthly',
    'trash_fee', 'pest_control_fee', 'technology_fee', 'last_month_rent',
    'early_termination_fee', 'other_fee', 'utility_water_responsibility',
    'utility_gas_responsibility', 'utility_electric_responsibility',
    'utility_sewer_responsibility', 'utility_trash_responsibility', 'custom_text',
    'sale_final_payment_amount', 'sale_final_payment_month'
  ]::text[]));

ALTER TABLE lease_template_fields
  DROP CONSTRAINT IF EXISTS lease_template_fields_lease_column_check;
ALTER TABLE lease_template_fields
  ADD CONSTRAINT lease_template_fields_lease_column_check
  CHECK (lease_column IS NULL OR lease_column = ANY (ARRAY[
    'tenant_name', 'tenant_email', 'landlord_name', 'unit_number', 'property_name',
    'property_address', 'date_signed_day', 'date_signed_month', 'tenant_2_name',
    'tenant_3_name', 'tenant_4_name', 'occupant_names', 'sale_price', 'sale_down_payment',
    'sale_financed_amount', 'sale_monthly_payment', 'sale_term_months', 'sale_interest_rate',
    'sale_first_payment_month', 'tenant_signature', 'landlord_signature', 'tenant_initial',
    'landlord_initial', 'date_signed', 'rent_amount', 'start_date', 'end_date',
    'security_deposit', 'move_in_first_month_rent', 'move_in_proration',
    'move_in_security_deposit', 'move_in_total_due', 'rent_due_day', 'lease_type', 'auto_renew',
    'auto_renew_mode', 'notice_days_required', 'expiration_notice_days', 'late_fee_grace_days',
    'late_fee_initial_flat', 'late_fee_initial_percent', 'late_fee_accrual_flat_daily',
    'late_fee_accrual_flat_weekly', 'late_fee_accrual_percent_daily',
    'late_fee_accrual_percent_weekly', 'late_fee_cap_flat', 'late_fee_cap_percent',
    'pet_deposit', 'key_deposit', 'cleaning_deposit', 'utility_deposit', 'move_in_fee',
    'cleaning_fee', 'pet_fee', 'application_fee', 'amenity_fee', 'hoa_transfer_fee',
    'lease_prep_fee', 'pet_rent', 'parking_rent', 'storage_rent', 'amenity_fee_monthly',
    'trash_fee', 'pest_control_fee', 'technology_fee', 'last_month_rent',
    'early_termination_fee', 'other_fee', 'utility_water_responsibility',
    'utility_gas_responsibility', 'utility_electric_responsibility',
    'utility_sewer_responsibility', 'utility_trash_responsibility', 'custom_text',
    'sale_final_payment_amount', 'sale_final_payment_month'
  ]::text[]));
