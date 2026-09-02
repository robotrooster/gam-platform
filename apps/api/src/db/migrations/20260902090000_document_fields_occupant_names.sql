-- S636 HOTFIX. My bug, shipped last night.
--
-- 20260901234500 added `occupant_names` to the CHECK on lease_template_fields
-- and stopped there. lease_document_fields carries its OWN copy of the same
-- vocabulary, and that is the table a draft actually inserts into — so the
-- template happily stored a field the document could never accept, and every
-- auto-draft off that template died at the insert:
--
--   new row for relation "lease_document_fields" violates check constraint
--   "lease_document_fields_lease_column_check"
--
-- The landlord's error said "this is usually the unit's default lease template
-- missing a required field," which sent them looking at their template. Nothing
-- was missing. Nic: "if anything is missing on my end, it shouldn't have let me
-- sign and complete." He is right — and it did not: the lease never drafted at
-- all, so residents who had accepted were left with nothing to sign.
--
-- WHY IT GOT PAST THE SUITE: no test drafts a document from a template carrying
-- occupant_names, so the two lists could disagree without anything failing.
-- Covered now in routes/esign.test.ts.
--
-- The real fix for the CLASS of bug is one vocabulary, not two — see
-- LEASE_COLUMNS in packages/shared. Both CHECKs are hand-maintained copies of
-- it, which is exactly the drift the single-source rule exists to stop. Widening
-- one without the other must be impossible, not merely remembered; a follow-up
-- should generate both from the shared list.
--
-- BACKFILL: none. No document field could ever have held this value.
ALTER TABLE lease_document_fields
  DROP CONSTRAINT IF EXISTS lease_document_fields_lease_column_check;

ALTER TABLE lease_document_fields
  ADD CONSTRAINT lease_document_fields_lease_column_check
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
