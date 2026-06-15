-- Complete Nevada's act catalog across unit types (S442 KB).
--
-- Verified from leg.state.nv.us 2026-06-11:
--   * NRS Chapter 118C is "LANDLORD AND TENANT: COMMERCIAL PREMISES" — a
--     distinct act for commercial tenancies. Add it, mapped to commercial +
--     storage units.
--   * NRS Chapter 118B (Manufactured Home Parks) defines "recreational
--     vehicle" (NRS 118B.018) and recognizes recreational-vehicle lots — so a
--     long-term RV space falls under 118B. Add rv_spot to 118B's unit_types.
--
-- After this, every GAM unit_type maps to a Nevada act:
--   apartment/single_family -> 118A; mobile_home/rv_spot -> 118B;
--   commercial/storage -> 118C.
--
-- 118C provisions are NOT seeded: commercial-premises law does not impose the
-- residential-style deposit/entry/late-fee caps (mirrors AZ's general act).
-- The act is catalogued + its full text ingested so "what law applies?" and
-- search work; no numeric provision warnings (correct — there are none).
--
-- The 118B unit_types UPDATE is a same-day catalog completion (adding a
-- coverage mapping that was verified after the initial seed), not a law
-- change. Additive otherwise; no backfill.

INSERT INTO public.state_landlord_tenant_acts
  (state_code, act_key, act_name, unit_types, official_url, summary, source_date, effective_year)
VALUES
  ('NV', 'commercial', 'Nevada Landlord and Tenant: Commercial Premises',
   ARRAY['commercial','storage'],
   'https://www.leg.state.nv.us/nrs/nrs-118c.html',
   'NRS Chapter 118C. Governs the rental of commercial premises.',
   DATE '2026-06-11', 2026);

UPDATE public.state_landlord_tenant_acts
   SET unit_types = ARRAY['mobile_home','rv_spot']
 WHERE state_code = 'NV' AND act_key = 'manufactured_home_park' AND effective_year = 2026;
