-- S642 (Nic): "Are you forgetting that we have fifty great states? Why are you
-- saying forty-nine?"
--
-- Because OREGON had no row — in any year. Not a knowledge gap: ORS 90.300
-- "Security deposits; prepaid rent" is in the corpus along with 2,067 other
-- Oregon sections. Only the extracted RATE row was missing, which left Oregon
-- resolving to rate_source = NULL, i.e. "no rule found".
--
-- The engine already treats that correctly — S604 made a missing rate stop
-- being a skip, so earnings still accrue and owed is simply 0. But "no rule
-- found" and "the statute says zero" are different facts, and only one of them
-- is safe to rely on. Oregon now states the second.
--
-- WHAT THE STATUTE SAYS. ORS 90.300 requires the landlord to HOLD the deposit
-- for the tenant and gives the tenant's claim priority over the landlord's
-- creditors including a trustee in bankruptcy — a custody rule. It sets no
-- interest obligation: the single occurrence of "interest" in the section is
-- "the holder of the landlord's INTEREST in the premises", a property interest.
--
-- UNIT TYPES. Oregon has no separate RV or manufactured-home chapter — ORS
-- chapter 90 is the whole landlord-tenant law, with manufactured dwelling parks
-- at 90.505 et seq. inside the same chapter. The row therefore covers every
-- unit type rather than leaving three of them silent, which is the failure this
-- migration exists to fix. FLAGGED FOR COUNSEL: whether ORS 90.300 reaches a
-- manufactured dwelling park space and an RV space identically is a legal
-- reading, not something the text states outright. It changes nothing
-- operationally today (zero either way) and everything about whether Oregon
-- looks answered.
INSERT INTO state_deposit_interest_rates
  (state_code, effective_year, annual_rate_pct, statute_citation, source_url,
   notes, unit_types, act_key, rate_basis)
SELECT 'OR', y, 0.0000,
  'Or. Rev. Stat. § 90.300',
  'https://oregon.public.law/statutes/ors_90.300',
  'No interest obligation. Custody IS restricted: the landlord "shall hold" the deposit for the tenant and the tenant''s claim is prior to the landlord''s creditors including a trustee in bankruptcy. Oregon has no separate RV or manufactured-home chapter — ORS ch. 90 covers all tenancies, manufactured dwelling parks at 90.505 et seq. Unit-type coverage beyond apartment/single_family is a reading of scope, not stated in the text; confirm with counsel before relying on it for a non-residential space.',
  ARRAY['apartment','single_family','mobile_home','rv_spot'],
  'residential', 'none'
FROM generate_series(2024, 2027) AS y
WHERE NOT EXISTS (
  SELECT 1 FROM state_deposit_interest_rates
   WHERE state_code = 'OR' AND effective_year = y
);
