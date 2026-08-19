-- S604: the last three states, closing 50-state coverage.
--
-- NH § 540-A:6 II — deposits "shall be held in trust ... and shall not be
--   mingled with the personal moneys or become an asset of the landlord", and
--   II(b) permits mingling ALL security deposits in a single trust account at a
--   bank, savings and loan or credit union "organized under the laws of this
--   state". Pooling across TENANTS is fine; pooling with the landlord's own
--   money is not, and the institution must be a New Hampshire one. Blocked for
--   a brokerage vehicle.
-- MN § 504B.178 — owes 1% simple non-compounded interest but imposes NO account
--   requirement. Supported.
-- RI — the 3% obligation is MOBILE HOME PARKS only (§ 31-44-7.1). Residential
--   § 34-18-19 caps the deposit at one month rent with no interest and no
--   account requirement. Supported.
--
-- CA / NV / NM were read on the previous pass but their pre-existing
-- needs_research rows survived an ON CONFLICT DO NOTHING. Corrected here.

INSERT INTO state_deposit_custody_rules
  (state_code, custody_status, allows_treasury_bills, requires_in_state_depository,
   requires_federally_insured, requires_interest_bearing, prohibits_use_of_funds,
   statute_citation, notes, researched_at)
VALUES
  ('NH', 'blocked', false, true, false, false, false, 'N.H. RSA 540-A:6 II',
   'Held in trust, not to be mingled with the landlord''s personal moneys or become his asset. II(b) expressly permits mingling ALL security deposits in a SINGLE trust account — pooling across tenants is allowed — but only at a bank, savings and loan or credit union "organized under the laws of this state".',
   '2026-08-14'),
  ('MN', 'supported', true, false, false, false, false, 'Minn. Stat. § 504B.178',
   'Owes 1% simple non-compounded interest but imposes NO account or institution requirement. Treasuries lawful.',
   '2026-08-14'),
  ('RI', 'supported', true, false, false, false, false,
   'R.I. Gen. Laws §§ 34-18-19, 31-44-7.1',
   'Residential: one-month cap, no interest, no account requirement. The 3% obligation is MOBILE HOME PARKS only. No custody restriction either way.',
   '2026-08-14')
ON CONFLICT (state_code) DO NOTHING;

UPDATE state_deposit_custody_rules
   SET custody_status = 'supported', allows_treasury_bills = true,
       researched_at = '2026-08-14', updated_at = now(),
       notes = notes || ' S604: read in full — no security-deposit account requirement. Treasuries lawful.'
 WHERE state_code IN ('CA','NV','NM');

-- RI residential owes nothing; the 3% row is mobile-home scoped.
INSERT INTO state_deposit_interest_rates
  (state_code, effective_year, annual_rate_pct, statute_citation, unit_types,
   act_key, rate_basis, notes)
VALUES
  ('RI', 2026, 0.0000, 'R.I. Gen. Laws § 34-18-19', ARRAY['apartment','single_family'],
   'residential', 'none',
   'Residential: deposit capped at one month periodic rent, no interest obligation. Contrast § 31-44-7.1, which owes 3% on MOBILE HOME park deposits.')
ON CONFLICT (state_code, effective_year, unit_types) DO NOTHING;
