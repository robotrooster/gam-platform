-- Nevada landlord/tenant law seed — second state for the S442 compliance KB
-- (see the Arizona migrations + 20260609140000_state_landlord_tenant_law_kb.sql).
--
-- SOURCED from the official Nevada Legislature site (leg.state.nv.us, NRS) on
-- 2026-06-11, verified against the statute text — not recalled. Note how the
-- figures DIFFER from Arizona (deposit 3mo vs AZ 1.5; entry 24h vs AZ 48h;
-- late fee 5% cap vs AZ's per-day $) — which is exactly why every state is
-- sourced separately and values are never copied across states.
--
-- The Nevada acts:
--   Ch 118A  Landlord and Tenant: Dwellings           → apartment, single_family
--   Ch 118B  Landlord and Tenant: Manufactured Home Parks → mobile_home
--
-- PROVISIONS seeded here are for the DWELLINGS act (118A) only — all verified.
-- The Manufactured Home Parks act (118B) is catalogued (so "what law applies?"
-- works for mobile-home units) but its own entry/deposit sections have
-- different values and get a separate sourced pass — do NOT copy 118A's
-- numbers onto it. Nevada has no separate RV long-term act like AZ Ch 19;
-- rv_spot mapping for NV is left unset pending verification of whether RVs
-- fall under 118B (no false mapping). notice_to_vacate (periodic tenancy) is
-- in NRS Ch 40, a separate chapter — added in a later pass.
--
-- Refresh discipline: never UPDATE these rows — future passes insert new
-- effective_year rows. Additive only, no backfill.

INSERT INTO public.state_landlord_tenant_acts
  (state_code, act_key, act_name, unit_types, official_url, summary, source_date, effective_year)
VALUES
  ('NV', 'residential', 'Nevada Residential Landlord and Tenant Act (Dwellings)',
   ARRAY['apartment','single_family'],
   'https://www.leg.state.nv.us/nrs/nrs-118a.html',
   'NRS Chapter 118A. Governs the rental of dwellings (apartments and houses) not in a manufactured home park.',
   DATE '2026-06-11', 2026),
  ('NV', 'manufactured_home_park', 'Nevada Landlord and Tenant: Manufactured Home Parks',
   ARRAY['mobile_home'],
   'https://www.leg.state.nv.us/nrs/nrs-118b.html',
   'NRS Chapter 118B. Governs the rental of spaces and homes in a manufactured home park.',
   DATE '2026-06-11', 2026);

INSERT INTO public.state_law_provisions
  (act_id, state_code, topic, rule_kind, threshold_numeric, threshold_unit, summary, statute_citation, source_url, source_date, effective_year)
SELECT a.id, 'NV', v.topic, v.rule_kind, v.threshold_numeric, v.threshold_unit, v.summary, v.citation, v.url, DATE '2026-06-11', 2026
FROM public.state_landlord_tenant_acts a
CROSS JOIN (VALUES
  ('entry_notice_hours', 'min', 24::numeric, 'hours',
   'The landlord must give the tenant at least 24 hours'' notice of intent to enter, and may enter only at reasonable times during normal business hours (except in an emergency).',
   'NRS 118A.330', 'https://www.leg.state.nv.us/nrs/nrs-118a.html'),
  ('deposit_max_months', 'max', 3::numeric, 'months of rent',
   'A security deposit (including any surety bond and last month''s rent) may not total more than 3 months'' periodic rent.',
   'NRS 118A.242', 'https://www.leg.state.nv.us/nrs/nrs-118a.html'),
  ('deposit_return_days', 'max', 30::numeric, 'days',
   'The landlord must return the balance of the deposit, with an itemized written accounting of any deductions, within 30 days after the tenancy ends.',
   'NRS 118A.242', 'https://www.leg.state.nv.us/nrs/nrs-118a.html'),
  ('late_fee_max_pct', 'max', 5::numeric, '% of rent',
   'A late fee must not exceed 5 percent of the periodic rent, and (for a tenancy longer than week-to-week) may not be charged until at least 3 calendar days after rent is due.',
   'NRS 118A.210', 'https://www.leg.state.nv.us/nrs/nrs-118a.html'),
  ('late_fee_grace_days', 'min', 3::numeric, 'days',
   'For a tenancy longer than week-to-week, no late fee may be charged or imposed until at least 3 calendar days after the date rent is due.',
   'NRS 118A.210', 'https://www.leg.state.nv.us/nrs/nrs-118a.html')
) AS v(topic, rule_kind, threshold_numeric, threshold_unit, summary, citation, url)
WHERE a.state_code = 'NV' AND a.act_key = 'residential' AND a.effective_year = 2026;
