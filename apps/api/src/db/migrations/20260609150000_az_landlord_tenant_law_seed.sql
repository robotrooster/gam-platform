-- Arizona landlord/tenant law seed — the reference state for the S442
-- compliance-warning KB (see 20260609140000_state_landlord_tenant_law_kb.sql).
--
-- SOURCED from the official Arizona Legislature site (azleg.gov, A.R.S.
-- Title 33) on 2026-06-09 — values verified against the statute text, not
-- recalled. Every row carries source_url + source_date; warnings built on
-- these always append the dated "may be newer info; not legal advice"
-- disclaimer.
--
-- The FOUR Arizona acts (Nic's "AZ has 4"), each governing different unit
-- types:
--   Ch 10  Residential Landlord and Tenant Act      → apartment, single_family
--   Ch 11  Mobile Home Parks Residential L&T Act     → mobile_home
--   Ch 19  Recreational Vehicle Long-Term Rental Act → rv_spot (>180 days)
--   Ch 3   Landlord and Tenant (general/innkeeper)   → commercial, storage
--
-- PROVISIONS seeded here are for the RESIDENTIAL act (Ch 10) only — all
-- verified. Mobile-home (Ch 11) and RV (Ch 19) acts have their OWN
-- entry/deposit sections with different values; those get their own SOURCED
-- pass (do NOT copy Ch 10's numbers onto them). Until then those acts are
-- catalogued (so "what law applies to my unit?" works) but fire no
-- provision warnings — the engine returns null on uncatalogued topics, so
-- no false alarms.
--
-- Annual/quarterly refresh: never UPDATE these rows — insert new
-- effective_year rows in a future migration.

-- ── Acts ──────────────────────────────────────────────────────────────
INSERT INTO public.state_landlord_tenant_acts
  (state_code, act_key, act_name, unit_types, official_url, summary, source_date, effective_year)
VALUES
  ('AZ', 'residential', 'Arizona Residential Landlord and Tenant Act',
   ARRAY['apartment','single_family'],
   'https://www.azleg.gov/arsDetail/?title=33',
   'A.R.S. Title 33, Chapter 10 (§§ 33-1301 to 33-1381). Governs most residential dwelling rentals — apartments and single-family homes.',
   DATE '2026-06-09', 2026),
  ('AZ', 'mobile_home_park', 'Arizona Mobile Home Parks Residential Landlord and Tenant Act',
   ARRAY['mobile_home'],
   'https://www.azleg.gov/arsDetail/?title=33',
   'A.R.S. Title 33, Chapter 11 (§§ 33-1401 to 33-1501). Governs rental of spaces in a mobile home park (4+ spaces).',
   DATE '2026-06-09', 2026),
  ('AZ', 'rv_long_term', 'Arizona Recreational Vehicle Long-Term Rental Space Act',
   ARRAY['rv_spot'],
   'https://www.azleg.gov/arsDetail/?title=33',
   'A.R.S. Title 33, Chapter 19 (§§ 33-2101 to 33-2151). Governs an RV space rented by the same tenant for more than 180 consecutive days.',
   DATE '2026-06-09', 2026),
  ('AZ', 'general', 'Arizona Landlord and Tenant (general)',
   ARRAY['commercial','storage'],
   'https://www.azleg.gov/arsDetail/?title=33',
   'A.R.S. Title 33, Chapter 3 (§§ 33-301 to 33-381). General landlord-tenant and innkeeper provisions for tenancies not covered by the residential acts.',
   DATE '2026-06-09', 2026);

-- ── Provisions (Residential Act, Ch 10) ──────────────────────────────────
INSERT INTO public.state_law_provisions
  (act_id, state_code, topic, rule_kind, threshold_numeric, threshold_unit, summary, statute_citation, source_url, source_date, effective_year)
SELECT a.id, 'AZ', v.topic, v.rule_kind, v.threshold_numeric, v.threshold_unit, v.summary, v.statute_citation, v.source_url, DATE '2026-06-09', 2026
FROM public.state_landlord_tenant_acts a
CROSS JOIN (VALUES
  ('entry_notice_hours', 'min', 48::numeric, 'hours',
   'Landlord must give at least two days'' (48 hours) notice of intent to enter, and enter at reasonable times — except in emergencies or where the tenant''s maintenance request constitutes permission to enter.',
   'A.R.S. § 33-1343', 'https://www.azleg.gov/ars/33/01343.htm'),
  ('deposit_max_months', 'max', 1.5::numeric, 'months of rent',
   'A security deposit may not exceed one and one-half months'' rent.',
   'A.R.S. § 33-1321', 'https://www.azleg.gov/ars/33/01321.htm'),
  ('deposit_return_days', 'max', 14::numeric, 'business days',
   'The landlord must return the deposit (with an itemized statement of any deductions) within 14 days, excluding weekends and legal holidays, after termination of the tenancy, delivery of possession, and the tenant''s demand.',
   'A.R.S. § 33-1321', 'https://www.azleg.gov/ars/33/01321.htm'),
  ('notice_to_vacate_days', 'min', 30::numeric, 'days',
   'A month-to-month tenancy requires at least 30 days'' written notice to terminate (a week-to-week tenancy requires at least 10 days).',
   'A.R.S. § 33-1375', 'https://www.azleg.gov/ars/33/01375.htm')
) AS v(topic, rule_kind, threshold_numeric, threshold_unit, summary, statute_citation, source_url)
WHERE a.state_code = 'AZ' AND a.act_key = 'residential' AND a.effective_year = 2026;
