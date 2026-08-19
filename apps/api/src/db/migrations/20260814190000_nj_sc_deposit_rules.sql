-- S604: close the NJ + SC corpus gap.
--
-- state_law_section_texts has no `residential` act for New Jersey or South
-- Carolina, so the S604 full-state read could not cover them. Both were
-- researched from primary/authoritative sources instead and are encoded here.
--
-- ── NEW JERSEY — N.J.S.A. 46:8-19 (Rent Security Deposit Act) ─────────────
-- OWES INTEREST, and the whole of it:
--   • "The interest or earnings paid thereon ... shall belong to the person
--     making the deposit or advance and shall be paid to the tenant in cash, or
--     be credited toward the payment of rent" — on lease renewal, the
--     anniversary date, or January 31.
--   • There is NO administrative-expense retention in the statute. Unlike NY
--     § 7-103 and PA § 250.511b (which both let the landlord keep 1% per annum),
--     New Jersey gives the tenant 100% of the earnings. Basis is therefore
--     `actual_earned`: GAM's spread in NJ is ZERO — but it can never be
--     negative either.
--   • Non-compliance is expensive: the tenant may apply the deposit "plus an
--     amount representing interest at the rate of seven percent per annum"
--     against rent.
--   • The 10-or-more-rental-units threshold in subsection (a) governs WHERE the
--     money is invested, NOT whether interest is owed — so it is recorded on the
--     custody rule, not as a min_property_units gate on the obligation.
--   • Interest is taxable income to the TENANT (banks request a W-9), which is
--     the 1099-INT path already noted for the trust structure.
--
-- ── SOUTH CAROLINA — S.C. Code § 27-40-410 ───────────────────────────────
-- NO obligation of any kind: no interest requirement, no segregated/escrow/
-- interest-bearing account requirement, and no cap on the deposit amount. The
-- section is concerned with itemised deductions and the 30-day return. Recorded
-- as an explicit `none` so it is not re-researched.
--
-- ⚠️ The corpus still lacks the verbatim NJ/SC statutory text. These rows carry
-- citations, not full text; ingesting the actual sections into
-- state_law_section_texts remains outstanding. Deliberately NOT inserting
-- paraphrased text into a table that is supposed to hold verbatim statute.

INSERT INTO state_deposit_interest_rates
  (state_code, effective_year, annual_rate_pct, statute_citation, unit_types,
   act_key, rate_basis, min_tenure_months, min_property_units, notes)
VALUES
  ('NJ', 2026, 0.0000, 'N.J.S.A. 46:8-19', '{}', 'residential',
   'actual_earned', NULL, NULL,
   'ALL interest/earnings belong to the tenant — no administrative retention, unlike NY 7-103 / PA 250.511b. Paid in cash or credited to rent annually (lease renewal, anniversary, or Jan 31). GAM spread is ZERO in NJ, never negative. Non-compliance lets the tenant apply the deposit plus 7% per annum against rent. Interest is taxable income to the tenant (W-9 / 1099-INT).'),
  ('SC', 2026, 0.0000, 'S.C. Code § 27-40-410', '{}', 'residential',
   'none', NULL, NULL,
   'No interest requirement, no segregated/escrow/interest-bearing account requirement, and no statutory cap on the deposit. Section governs itemised deductions and the 30-day return only. Verified negative.')
ON CONFLICT (state_code, effective_year, unit_types) DO NOTHING;

-- ── Custody vehicle ──────────────────────────────────────────────────────
INSERT INTO state_deposit_custody_rules
  (state_code, custody_status, allows_treasury_bills, requires_in_state_depository,
   requires_federally_insured, requires_interest_bearing, prohibits_use_of_funds,
   statute_citation, notes, researched_at)
VALUES
  ('NJ', 'needs_research', false, true, true, true, false, 'N.J.S.A. 46:8-19',
   'Landlords with 10+ rental units may "invest that money in shares of an insured money market fund" OR deposit it in a State/federally chartered bank; under 10 units must deposit in an insured NJ bank at the rate currently paid on time or savings deposits. A MONEY MARKET FUND is expressly contemplated, which is the closest any statute so far comes to permitting GAM''s vehicle — but the qualifying criteria for an "insured" fund have NOT been read in full, and the in-state bank requirement applies below 10 units. Resolve before NJ onboarding.',
   '2026-08-14'),
  ('SC', 'supported', true, false, false, false, false, 'S.C. Code § 27-40-410',
   'No custody restriction of any kind — no segregated, escrow, in-state, or interest-bearing account requirement. Treasury bills are lawful. Paired with a `none` interest obligation, SC deposits are pure spread.',
   '2026-08-14')
ON CONFLICT (state_code) DO NOTHING;
