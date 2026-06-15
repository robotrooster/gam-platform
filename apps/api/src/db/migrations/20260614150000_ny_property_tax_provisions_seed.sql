-- NY property-tax structured provisions — PILOT seed (validates the
-- state_property_tax_provisions schema on real, verified data; NY is the pilot
-- state, mirroring how AZ piloted the landlord/tenant KB).
--
-- Every fact is verbatim-verified against the NY Real Property Tax Law (RPT)
-- text already in state_law_section_texts (law_category='property_tax'),
-- 2026-06-14. Figures that localities set/vary carry params.locally_variable=true
-- so the feature never implies a single statewide number. Annual-refresh:
-- effective_year=2026; next year INSERT new rows, never UPDATE.
--
-- This is the sanctioned no-state-legal carve-out: sourced + dated + factual.

INSERT INTO state_property_tax_provisions
  (state_code, jurisdiction_level, topic, subtype, summary, params, statute_citation, source_url, source_date, effective_year)
VALUES
  -- Assessment grievance deadline (RPTL § 512: complaints heard "beginning on
  -- the fourth Tuesday of May, or such other date as is established by city
  -- charter, county charter, county tax act or other special law").
  ('NY', 'state', 'assessment_appeal', NULL,
   'Assessment complaints are heard by the Board of Assessment Review beginning on the fourth Tuesday in May (Grievance Day), unless a city/county charter or special law sets another date.',
   '{"deadline_kind":"fixed_date","deadline_month":5,"deadline_desc":"fourth Tuesday in May (Grievance Day)","review_body":"Board of Assessment Review","locally_variable":true}'::jsonb,
   'N.Y. Real Prop. Tax Law § 512', 'https://www.nysenate.gov/legislation/laws/RPT/512', '2026-06-14', 2026),

  -- Senior citizens exemption (RPTL § 467): owners 65+, up to 50% assessed-value
  -- reduction; each taxing jurisdiction adopts it and sets the income ceiling
  -- within the state-authorized maximum.
  ('NY', 'state', 'exemption', 'senior',
   'Owners aged 65+ may receive up to a 50% reduction in assessed value. Each taxing jurisdiction must adopt the exemption and sets the income ceiling (within the state-authorized maximum).',
   '{"age_min":65,"ownership_required":true,"benefit_kind":"pct_reduction","benefit_value":50,"benefit_unit":"pct","income_max":null,"locally_variable":true,"notes":"Income ceiling is set locally within the state maximum; verify the current-year figure for the jurisdiction."}'::jsonb,
   'N.Y. Real Prop. Tax Law § 467', 'https://www.nysenate.gov/legislation/laws/RPT/467', '2026-06-14', 2026),

  -- STAR school-tax relief (RPTL § 425): owner-occupied primary residence;
  -- Basic (income-limited) and Enhanced (65+, lower income limit) variations.
  -- Exempt amounts / income limits are state-set and change yearly.
  ('NY', 'state', 'exemption', 'star',
   'School Tax Relief (STAR): owner-occupied primary residences are exempt from a portion of school taxes. Basic STAR (income-limited) and Enhanced STAR (age 65+, lower income limit). Exempt amounts and income limits are set by the state and change annually.',
   '{"primary_residence_required":true,"benefit_kind":"exempt_value_cap","locally_variable":false,"notes":"Two variations: Basic STAR and Enhanced STAR (65+). Amounts/income limits change yearly — pull the current-year figure."}'::jsonb,
   'N.Y. Real Prop. Tax Law § 425', 'https://www.nysenate.gov/legislation/laws/RPT/425', '2026-06-14', 2026),

  -- Veterans exemption (RPTL § 458 eligible-funds; most localities instead adopt
  -- the alternative veterans exemption, § 458-a, at locally-chosen levels).
  ('NY', 'state', 'exemption', 'veteran',
   'Eligible-funds veterans exemption for property bought with pension/bonus/insurance proceeds. Most localities instead offer the alternative veterans exemption (§ 458-a) at locally-adopted levels.',
   '{"ownership_required":true,"benefit_kind":"exempt_value_cap","locally_variable":true,"notes":"§ 458 eligible-funds exemption; see § 458-a (alternative veterans) and § 458-b (cold war veterans) for the more common locally-adopted options."}'::jsonb,
   'N.Y. Real Prop. Tax Law § 458', 'https://www.nysenate.gov/legislation/laws/RPT/458', '2026-06-14', 2026),

  -- Redemption period (RPTL § 1110(2)): expires two years after lien date; a tax
  -- district may increase it for residential/farm property or reduce it (§ 1111).
  ('NY', 'state', 'delinquency_redemption', NULL,
   'Delinquent property may be redeemed until the redemption period expires — two years after the lien date by default. A tax district may increase the period for residential or farm property, or reduce it.',
   '{"redemption_period_months":24,"tax_sale_kind":"tax_lien","locally_variable":true,"notes":"Default 2 years after lien date; districts may extend (residential/farm) or reduce per § 1111."}'::jsonb,
   'N.Y. Real Prop. Tax Law § 1110', 'https://www.nysenate.gov/legislation/laws/RPT/1110', '2026-06-14', 2026);
