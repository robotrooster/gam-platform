-- S558 (Nic): a FLAT-RATE utility billing method. Some properties bill certain
-- utilities (e.g. trash) as a fixed per-unit amount, not by meter usage — but
-- the landlord still wants it as its OWN line item so the tenant sees what they
-- pay for (vs. silently folding it into rent). No reading; each served unit
-- bills the meter's flat amount (base_fee) per cycle. Utility-neutral.
--
-- Extend the billing_method CHECK to add 'flat_rate'. The existing
-- utility_meters_check (rubs ⇔ rubs_allocation_method) already permits flat_rate
-- (non-rubs → allocation_method NULL), so only this constraint changes.
ALTER TABLE public.utility_meters DROP CONSTRAINT utility_meters_billing_method_check;
ALTER TABLE public.utility_meters ADD CONSTRAINT utility_meters_billing_method_check
  CHECK (billing_method = ANY (ARRAY['submeter'::text, 'rubs'::text, 'master_bill_to_landlord'::text, 'flat_rate'::text]));
