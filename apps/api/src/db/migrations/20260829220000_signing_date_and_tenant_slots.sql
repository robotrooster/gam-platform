-- S629 (Nic): five new data labels, so a lease form can say who is on it and
-- when it was entered into without anybody retyping either.
--
-- date_signed_day / date_signed_month
--   "made and entered into on this ___ day of ___" is the EXECUTION clause —
--   when the agreement is formed. Nic asked the right question ("does this
--   field indicate lease start or signing date, because there is a difference
--   and it matters"): it is the signing date, and it is NOT the term start,
--   which this document carries separately on page 2.
--
--   His template had "Day" mapped to start_date, so a full ISO date was stamped
--   into a box the width of a day number and rendered as a clipped "2".
--
--   Tied to the LANDLORD's signature in particular, in his words: "if the
--   tenant waits to sign it till after midnight, that's not the day I signed
--   it." Landlord-role fields, stamped when he signs first, then stored.
--
-- tenant_2_name / tenant_3_name / tenant_4_name
--   The four tenant-name blanks on a lease form are the roster in order. They
--   were unmapped, landlord-role and REQUIRED, so a one-tenant lease asked the
--   landlord to type three names that do not exist. Named slots let the draft
--   fill the ones that have a tenant, from the invite, and OMIT the ones that
--   do not — the same way a co-tenant's signature field is already omitted.
--   "I already spelled their name right once when I sent the invite."
--
-- All five are display-only ('identity' in LEASE_COLUMN_CATEGORY): they render
-- into the document and are never written back to the leases table.

ALTER TABLE lease_template_fields DROP CONSTRAINT IF EXISTS lease_template_fields_lease_column_check;
ALTER TABLE lease_document_fields DROP CONSTRAINT IF EXISTS lease_document_fields_lease_column_check;

DO $$
DECLARE cols text;
BEGIN
  cols := 'tenant_name,tenant_email,landlord_name,unit_number,property_name,property_address,'
       || 'tenant_signature,landlord_signature,tenant_initial,landlord_initial,date_signed,'
       || 'date_signed_day,date_signed_month,tenant_2_name,tenant_3_name,tenant_4_name,'
       || 'rent_amount,start_date,end_date,security_deposit,rent_due_day,lease_type,auto_renew,'
       || 'auto_renew_mode,notice_days_required,expiration_notice_days,late_fee_grace_days,'
       || 'late_fee_initial_flat,late_fee_initial_percent,late_fee_accrual_flat_daily,'
       || 'late_fee_accrual_flat_weekly,late_fee_accrual_flat_monthly,late_fee_accrual_percent_daily,'
       || 'late_fee_accrual_percent_weekly,late_fee_accrual_percent_monthly,late_fee_cap_flat,'
       || 'late_fee_cap_percent,pet_deposit,key_deposit,cleaning_deposit,move_in_fee,cleaning_fee,'
       || 'pet_fee,application_fee,amenity_fee,hoa_transfer_fee,lease_prep_fee,pet_rent,parking_rent,'
       || 'storage_rent,amenity_fee_monthly,trash_fee,pest_control_fee,technology_fee,last_month_rent,'
       || 'early_termination_fee,other_fee,utility_water_responsibility,utility_gas_responsibility,'
       || 'utility_electric_responsibility,utility_sewer_responsibility,utility_trash_responsibility,'
       || 'sale_price,sale_down_payment,sale_financed_amount,sale_monthly_payment,sale_term_months,'
       || 'sale_interest_rate,sale_first_payment_month,custom_text';

  EXECUTE format(
    'ALTER TABLE lease_template_fields ADD CONSTRAINT lease_template_fields_lease_column_check
       CHECK (lease_column IS NULL OR lease_column = ANY (ARRAY[%s]))',
    (SELECT string_agg(quote_literal(c) || '::text', ',') FROM unnest(string_to_array(cols, ',')) AS c));

  EXECUTE format(
    'ALTER TABLE lease_document_fields ADD CONSTRAINT lease_document_fields_lease_column_check
       CHECK (lease_column IS NULL OR lease_column = ANY (ARRAY[%s]))',
    (SELECT string_agg(quote_literal(c) || '::text', ',') FROM unnest(string_to_array(cols, ',')) AS c));
END $$;
