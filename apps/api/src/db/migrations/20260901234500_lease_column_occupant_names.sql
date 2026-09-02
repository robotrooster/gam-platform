-- S635 (Nic): "the tenant names and the NAMES OF THE OCCUPANTS both are landlord
-- boxes, and those should be derived from all the invites that went out."
--
-- The tenant-name blanks already had somewhere to point: tenant_name and
-- tenant_2/3/4_name, filled from the roster at send time. The "names of
-- occupants" blank — one line listing everybody on the lease — had NO column in
-- the vocabulary at all, so a landlord placing it could only leave it unmapped
-- and type the names by hand. On the Oak Park mobile home template it was
-- mapped to `tenant_name`, which printed the primary's name alone where the form
-- asks for the household.
--
-- `occupant_names` is the whole roster, in household order, on one line. It is
-- an 'identity' column like the others: derived, never anyone's to fill in.
--
-- BACKFILL: none. Existing fields keep whatever they are mapped to; this only
-- makes a better target available.
ALTER TABLE lease_template_fields
  DROP CONSTRAINT IF EXISTS lease_template_fields_lease_column_check;

ALTER TABLE lease_template_fields
  ADD CONSTRAINT lease_template_fields_lease_column_check
  CHECK (lease_column IS NULL OR lease_column = ANY (ARRAY[
    'tenant_name','tenant_email','landlord_name','unit_number','property_name',
    'property_address','tenant_signature','landlord_signature','tenant_initial',
    'landlord_initial','date_signed','date_signed_day','date_signed_month',
    'tenant_2_name','tenant_3_name','tenant_4_name','occupant_names',
    'rent_amount','start_date','end_date','security_deposit','rent_due_day',
    'lease_type','auto_renew','auto_renew_mode','notice_days_required',
    'expiration_notice_days','late_fee_grace_days','late_fee_initial_flat',
    'late_fee_initial_percent','late_fee_accrual_flat_daily',
    'late_fee_accrual_flat_weekly','late_fee_accrual_flat_monthly',
    'late_fee_accrual_percent_daily','late_fee_accrual_percent_weekly',
    'late_fee_accrual_percent_monthly','late_fee_cap_flat','late_fee_cap_percent',
    'pet_deposit','key_deposit','cleaning_deposit','move_in_fee','cleaning_fee',
    'pet_fee','application_fee','amenity_fee','hoa_transfer_fee','lease_prep_fee',
    'pet_rent','parking_rent','storage_rent','amenity_fee_monthly','trash_fee',
    'pest_control_fee','technology_fee','last_month_rent','early_termination_fee',
    'other_fee','utility_water_responsibility','utility_gas_responsibility',
    'utility_electric_responsibility','utility_sewer_responsibility',
    'utility_trash_responsibility','sale_price','sale_down_payment',
    'sale_financed_amount','sale_monthly_payment','sale_term_months',
    'sale_interest_rate','sale_first_payment_month','custom_text']));
