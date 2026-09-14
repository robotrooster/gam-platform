-- S642 — Nic: "I want you to read all the statutes right now… preventative
-- action now instead of reacting at a later time." Good call: the sweep found
-- ILLINOIS owed money and had no rule.
--
-- Illinois had exactly one deposit row — the Mobile Home Landlord and Tenant
-- Rights Act (765 ILCS 745/18), covering mobile_home and rv_spot. There was NO
-- residential row, so an Illinois APARTMENT or SINGLE-FAMILY rental resolved to
-- "no rule found" and accrued zero owed. Illinois is not a zero state.
--
-- 765 ILCS 715/2 is in the corpus and is unambiguous: "The lessor shall, within
-- 30 days after the end of each 12 month rental period, pay to the lessee any
-- interest that has accumulated to an amount of $5 or more… shall pay all
-- interest that has accumulated and remains unpaid, regardless of the amount,
-- upon termination of the tenancy." Willful refusal makes the lessor "liable
-- for an amount equal to the amount of the security deposit, together with
-- court costs and reasonable attorneys fees" — the deposit AGAIN, plus fees.
--
-- Structure mirrors the mobile-home twin already modelled: a 25-unit gate and a
-- passbook-savings index rather than a fixed rate. Same legislature, same
-- mechanism, adjacent chapters.
--
-- ⚠ ONE PIECE IS NOT IN THE CORPUS. 765 ILCS 715/1 — which states the 25-unit
-- threshold and names the index — is absent; the section filed as IL
-- residential "1" is a different act (liability exemptions). The obligation in
-- §2 is certain because it is quoted above. The 25-unit gate and the index are
-- carried over from 745/18, whose text IS present and states both. Confirm
-- 715/1 before relying on the threshold, and note that a WRONG threshold here
-- fails safe in only one direction: too low a gate over-pays tenants, too high
-- under-pays them. 25 matches the sibling act.
INSERT INTO state_deposit_interest_rates
  (state_code, effective_year, annual_rate_pct, statute_citation, source_url,
   notes, unit_types, act_key, rate_basis, min_property_units)
SELECT 'IL', y, 0.0000,
  '765 ILCS 715/1-2',
  'https://www.ilga.gov/legislation/ilcs/ilcs3.asp?ActID=2205',
  'Security Deposit Interest Act. Lessors of residential property with 25 or more units pay the passbook savings rate of the largest commercial bank headquartered in Illinois as of Dec 31 prior — the same index and gate as the mobile-home act (765 ILCS 745/18) next door. Paid within 30 days after each 12-month rental period once accrued interest reaches $5, and in full at termination regardless of amount. Willful refusal = liability for the deposit amount again plus costs and attorney fees. Under 25 units: no obligation. REFRESH the index annually. ⚠ 765 ILCS 715/1 is not in the corpus — the $5/30-day/termination obligation is quoted verbatim from 715/2, but the 25-unit threshold and index are carried from the sibling act; confirm 715/1.',
  ARRAY['apartment','single_family'],
  'residential', 'index_linked', 25
FROM generate_series(2024, 2027) AS y
WHERE NOT EXISTS (
  SELECT 1 FROM state_deposit_interest_rates
   WHERE state_code = 'IL' AND effective_year = y AND act_key = 'residential'
);
