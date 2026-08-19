-- S604: full read of every state's tenancy acts for deposit-interest obligations.
--
-- Read BY HAND from state_law_section_texts (the 50-state corpus), section by
-- section, rather than pattern-matched. That mattered: a crude keyword sweep had
-- flagged IA and KS as interest-bearing states, and reading them in full shows
-- both say the opposite — "any interest earned on a security deposit shall be
-- the property of the LANDLORD".
--
-- The read surfaced four statutory shapes the catalog could not express:
--
--   1. ACTUAL-EARNED bases. ND § 47-16-07.1 ("the security deposit and any
--      interest accruing on the deposit must be paid to the lessee"), NH
--      § 540-A:6 (rate = what the bank actually pays). Cannot go negative.
--   2. ACTUAL-MINUS-ADMIN. NY Gen. Oblig. § 7-103 and PA § 511.2 both let the
--      landlord keep "a sum equivalent to one per cent per annum ... in lieu of
--      all other administrative and custodial expenses" and pay the tenant the
--      balance. GAM keeps the 1% plus anything above. Cannot go negative.
--   3. INDEX-LINKED. CT § 47a-21 pays "not less than the deposit index" (§ 36a-26)
--      with a 1.5% historical floor; IL Mobile Home Landlord and Tenant Rights
--      Act § 18 pays the passbook rate of the largest commercial bank in the
--      state. These float and must be refreshed annually like the rest.
--   4. GATES. Obligations that only switch on past a threshold:
--        • tenure  — IA (landlord keeps interest for the FIRST FIVE YEARS),
--                    NH (held one year or longer), PA (held more than two years)
--        • property size — IL (parks "regularly containing 25 or more mobile
--                    homes"), NY (six-or-more-family dwellings)
--
-- VERIFIED NEGATIVES are recorded as rows, not omissions. "No row" is ambiguous
-- between "owes nothing" and "nobody looked"; an explicit rate_basis='none' row
-- with its citation means a future session does not re-research it.
--
-- ⚠️ CORPUS GAPS: the corpus has no `residential` act for NEW JERSEY or SOUTH
-- CAROLINA. New Jersey (N.J.S.A. 46:8-19) DOES impose a deposit-interest
-- obligation and is a large rental market — it is NOT covered below and must be
-- researched from primary sources before any NJ onboarding. The custody/interest
-- onboarding flag fails closed for both, so an NJ landlord still trips an alert.

-- ── Schema: express the shapes found above ────────────────────────────────
ALTER TABLE state_deposit_interest_rates
  ADD COLUMN IF NOT EXISTS admin_retention_pct numeric(6,4),
  ADD COLUMN IF NOT EXISTS min_tenure_months   integer,
  ADD COLUMN IF NOT EXISTS min_property_units  integer;

ALTER TABLE state_deposit_interest_rates DROP CONSTRAINT IF EXISTS sdir_rate_basis_check;
ALTER TABLE state_deposit_interest_rates
  ADD CONSTRAINT sdir_rate_basis_check CHECK (
    rate_basis IN ('fixed','lesser_of_actual','share_of_actual',
                   'actual_earned','actual_minus_admin','index_linked','none')
    AND (rate_basis <> 'share_of_actual'   OR actual_share_pct    IS NOT NULL)
    AND (rate_basis <> 'actual_minus_admin' OR admin_retention_pct IS NOT NULL)
  );

COMMENT ON COLUMN state_deposit_interest_rates.admin_retention_pct IS
  'S604: annual %% of principal the landlord may retain as administrative expense before the balance of interest goes to the tenant (NY 7-103, PA 511.2 = 1%%).';
COMMENT ON COLUMN state_deposit_interest_rates.min_tenure_months IS
  'S604: obligation only attaches once the deposit has been held this long (IA 60, NH 12, PA 24). NULL = from day one.';
COMMENT ON COLUMN state_deposit_interest_rates.min_property_units IS
  'S604: obligation only attaches at properties of at least this size (IL mobile home parks 25+, NY 6-or-more-family). NULL = any size.';

-- ── Seed: every state read in full, 2026 ──────────────────────────────────
-- unit_types '{}' = blanket state rule. A unit-type row outranks it.
INSERT INTO state_deposit_interest_rates
  (state_code, effective_year, annual_rate_pct, statute_citation, unit_types,
   act_key, rate_basis, actual_share_pct, admin_retention_pct,
   min_tenure_months, min_property_units, notes)
VALUES
  -- ══ OWES INTEREST ══
  ('CT', 2026, 1.5000, 'Conn. Gen. Stat. § 47a-21(i)', '{}', 'residential',
   'index_linked', NULL, NULL, NULL, NULL,
   'Rate is "not less than the deposit index" (§ 36a-26) for the calendar year; 1.5% was the pre-1994 floor and is stored as the fallback. Expressly covers mobile manufactured homes, lots and parks (§ 21-64 definitions) as well as residential. EXEMPTS student housing owned/controlled by an educational institution. REFRESH the index annually.'),
  ('RI', 2026, 3.0000, 'R.I. Gen. Laws § 31-44-7.1', ARRAY['mobile_home'], 'mobile_home_park',
   'fixed', NULL, NULL, NULL, NULL,
   'Mobile home park deposits "accumulate interest on an annual basis at the rate of three percent (3%)". Deposit capped at one month rent; interest paid annually or on termination. FIXED basis — can run negative against market yield.'),
  ('IL', 2026, 0.0000, '765 ILCS 745/18', ARRAY['mobile_home'], 'mobile_home_park',
   'index_linked', NULL, NULL, NULL, 25,
   'Parks "regularly containing 25 or more mobile homes" pay the passbook savings rate of the largest commercial bank headquartered in Illinois as of Dec 31 prior. Paid within 30 days after each 12-month period. Under 25 homes: no obligation. REFRESH annually.'),
  ('NY', 2026, 0.0000, 'N.Y. Gen. Oblig. Law § 7-103', '{}', 'residential',
   'actual_minus_admin', NULL, 1.0000, NULL, 6,
   'Deposits in six-or-more-family dwellings must sit in a NY interest-bearing account; landlord retains 1% per annum as administrative expense "in lieu of all other administrative and custodial expenses" and the balance of interest is the tenant''s. GAM keeps the 1% plus any excess — cannot go negative.'),
  ('PA', 2026, 0.0000, '68 P.S. § 250.511b', '{}', 'residential',
   'actual_minus_admin', NULL, 1.0000, 24, NULL,
   'Applies to deposits over $100 held MORE THAN TWO YEARS. Lessor retains 1% per annum as administrative expense; balance of interest paid to tenant annually on the lease anniversary. No obligation in the first two years.'),
  ('ND', 2026, 0.0000, 'N.D. Cent. Code § 47-16-07.1', '{}', 'residential',
   'actual_earned', NULL, NULL, NULL, NULL,
   'Deposit must sit in a federally insured interest-bearing account for the benefit of the tenant; "the security deposit and any interest accruing on the deposit must be paid to the lessee upon termination". Whole yield passes through — no spread, but no loss.'),
  ('NH', 2026, 0.0000, 'N.H. RSA 540-A:6', '{}', 'residential',
   'actual_earned', NULL, NULL, 12, NULL,
   'Only where the deposit is held ONE YEAR OR LONGER. Rate equals what the bank actually pays on regular savings where deposited; if commingled in a single account, actual interest is paid proportionately to each tenant.'),
  ('IA', 2026, 0.0000, 'Iowa Code § 562A.12', '{}', 'residential',
   'actual_earned', NULL, NULL, 60, NULL,
   'Interest earned during the FIRST FIVE YEARS of a tenancy is the property of the landlord; after that it follows the tenant. Most tenancies never reach the gate.'),

  -- ══ VERIFIED NO OBLIGATION (recorded so nobody re-researches them) ══
  ('CA', 2026, 0.0000, 'Cal. Civ. Code § 798.39(f)', ARRAY['mobile_home'], 'mobile_home_park',
   'none', NULL, NULL, NULL, NULL,
   'Mobilehome Residency Law: management "shall not be required to place any security deposit collected in an interest-bearing account or to provide a homeowner with any interest on the security deposit collected." Explicit negative.'),
  ('IA', 2026, 0.0000, 'Iowa Code § 562B.13', ARRAY['mobile_home'], 'mobile_home_park',
   'none', NULL, NULL, NULL, NULL,
   'Manufactured home communities / mobile home parks: "Any interest earned on a rental deposit shall be the property of the landlord." Overrides the residential 5-year rule for this unit type.'),
  ('KS', 2026, 0.0000, 'Kan. Stat. § 58-25,108', ARRAY['mobile_home'], 'mobile_home_park',
   'none', NULL, NULL, NULL, NULL,
   '"Any interest earned on a security deposit shall be the property of the landlord." Explicit negative.'),
  ('NV', 2026, 0.0000, 'Nev. Rev. Stat. § 118B.150', ARRAY['mobile_home'], 'manufactured_home_park',
   'none', NULL, NULL, NULL, NULL,
   'Landlord "is not required to place such a deposit into a financial institution or to pay interest on the deposit." Explicit negative.'),
  ('VA', 2026, 0.0000, 'Va. Code § 55.1-1200 et seq.', '{}', 'residential',
   'none', NULL, NULL, NULL, NULL,
   'VRLTA carries no obligation to pay interest on security deposits; the only interest language concerns transferring ACCRUED interest to a new owner on sale of the property. Explicit negative.')
ON CONFLICT (state_code, effective_year, unit_types) DO NOTHING;

-- AZ residential + rv_long_term: explicit negatives alongside the existing
-- mobile_home 5% row, so the Arizona picture is complete in the catalog rather
-- than inferred from the absence of rows.
INSERT INTO state_deposit_interest_rates
  (state_code, effective_year, annual_rate_pct, statute_citation, unit_types,
   act_key, rate_basis, notes)
VALUES
  ('AZ', 2026, 0.0000, 'A.R.S. § 33-1321', ARRAY['apartment','single_family'], 'residential',
   'none',
   'Residential landlord-tenant act: deposits capped at one and one-half month rent, no interest requirement. Contrast § 33-1431(B) which owes 5% on MOBILE HOME park deposits.'),
  ('AZ', 2026, 0.0000, 'A.R.S. § 33-2121', ARRAY['rv_spot'], 'rv_long_term',
   'none',
   'Recreational vehicle long-term rental spaces: deposit and 14-day return, no interest requirement.')
ON CONFLICT (state_code, effective_year, unit_types) DO NOTHING;
