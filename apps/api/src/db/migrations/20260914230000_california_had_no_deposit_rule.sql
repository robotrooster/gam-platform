-- S642 — chasing Oregon turned up a bigger hole: CALIFORNIA had exactly one
-- deposit rule, for mobile homes (Civ. Code § 798.39(f)). No residential row at
-- all, so a California apartment, single-family home OR RV space all resolved
-- to "no rule found" — in the largest rental market in the country.
--
-- Cal. Civ. Code § 1950.5 is in the corpus (26KB of it). It sets no interest
-- obligation: 26 occurrences of "interest" and not one is "pay interest" or
-- "interest on the security" — they are all "the landlord's INTEREST in the
-- premises" and "successor in interest", i.e. property interests.
--
-- ⚠ LOCAL ORDINANCES ARE THE REAL EXPOSURE HERE, and GAM models state law only.
-- California has no statewide requirement, but several CITIES do require
-- interest on residential deposits by ordinance — San Francisco, Los Angeles,
-- Santa Monica, Berkeley, West Hollywood, Hayward among them. A statewide 0%
-- row is correct as state law and WRONG inside those cities. Nothing in this
-- schema can express that today; the note is the warning until city-level rules
-- exist. Flagged rather than silently encoded as "nothing owed in California".
--
-- NOT extended to rv_spot, deliberately. California's Recreational Vehicle Park
-- Occupancy Law (Civ. Code §§ 799.20-799.79, all 34 sections present) does not
-- address security deposits at all. Whether § 1950.5 reaches an RV park
-- occupancy is an open question of scope, and answering it by quietly widening
-- an array would turn a legal question into a silent assumption. An RV space in
-- California still resolves to rate_source = NULL, which is the honest answer:
-- we do not know, and the engine already treats that as owed-zero-but-unknown
-- rather than as a rule saying zero.
INSERT INTO state_deposit_interest_rates
  (state_code, effective_year, annual_rate_pct, statute_citation, source_url,
   notes, unit_types, act_key, rate_basis)
SELECT 'CA', y, 0.0000,
  'Cal. Civ. Code § 1950.5',
  'https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=CIV&sectionNum=1950.5',
  'No STATEWIDE interest obligation — § 1950.5 sets deposit caps, itemisation and 21-day return, and says nothing about paying interest. ⚠ LOCAL ORDINANCES DIFFER: San Francisco, Los Angeles, Santa Monica, Berkeley, West Hollywood and Hayward among others require interest on residential deposits by city ordinance. GAM models state law only, so this row is wrong inside those cities. Confirm the municipality before relying on it.',
  ARRAY['apartment','single_family'],
  'residential', 'none'
FROM generate_series(2024, 2027) AS y
WHERE NOT EXISTS (
  SELECT 1 FROM state_deposit_interest_rates
   WHERE state_code = 'CA' AND effective_year = y AND act_key = 'residential'
);
