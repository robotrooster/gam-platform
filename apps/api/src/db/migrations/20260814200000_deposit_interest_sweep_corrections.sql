-- S604 corrections: re-ran the deposit-interest sweep across ALL act_keys.
--
-- The original full-state read filtered on act_key IN ('residential',
-- 'mobile_home_park','manufactured_home_park','rv_park','rv_long_term',
-- 'self_storage','condo_coop'). That EXCLUDED `general_landlord_tenant`, which
-- is where 16 states — including New Jersey, South Carolina and Missouri — file
-- their landlord-tenant law. The corpus was never missing those states; the
-- query was. Re-swept with no act_key filter.
--
-- Corrections below:
--
--   MISSOURI § 535.300 — verified NEGATIVE, was missed entirely.
--     "Any interest earned on a security deposit shall be the property of the
--     landlord." Same shape as IA/KS mobile home. Recorded explicitly.
--
--   ILLINOIS 765 ILCS 745/18 — scope was too narrow. The identical section text
--     is filed under mobile_home_park, manufactured_home_park AND **rv_park**,
--     so the obligation reaches RV park tenants too, not just mobile homes.
--     Widened to cover rv_spot. Missing this would have under-paid every RV
--     tenant in a 25+-space Illinois park.
--
--   NEW JERSEY § 46:8-19 — custody note refined against the VERBATIM corpus
--     text, which is stricter than the secondary source used earlier: the money
--     market fund must be "established by an investment company **based in this
--     State**". A NJ-based investment company is a materially narrower set than
--     "any insured money market fund", and probably excludes GAM's intended
--     custodian. NJ custody stays needs_research, now for a sharper reason.
--
--   NORTH CAROLINA § 42A-15 (Vacation Rental Act) — trust-account payments
--     "shall not earn interest unless the landlord and tenant agree in the
--     vacation rental agreement", which also names who receives it. Contractual,
--     not statutory: no default obligation. Relevant because GAM does short
--     stays. Recorded as a note-bearing negative.
--
-- NY § 7-107 and § 7-108 were also read on this pass: both concern a successor
-- owner's liability for the deposit "plus accrued interest" on conveyance, and
-- neither creates an independent rate obligation. The NY rate rule remains
-- § 7-103 (actual minus 1% admin). No change.

-- ── Missouri: verified negative ──────────────────────────────────────────
INSERT INTO state_deposit_interest_rates
  (state_code, effective_year, annual_rate_pct, statute_citation, unit_types,
   act_key, rate_basis, notes)
VALUES
  ('MO', 2026, 0.0000, 'Mo. Rev. Stat. § 535.300', '{}', 'general_landlord_tenant',
   'none',
   'Deposit must be held in an institution insured by an agency of the federal government, but "any interest earned on a security deposit shall be the property of the landlord." Housing authorities and government-entity landlords are exempt from the account requirement. Verified negative — GAM keeps the whole yield.'),
  ('NC', 2026, 0.0000, 'N.C.G.S. § 42A-15', '{}', 'general_landlord_tenant',
   'none',
   'Vacation Rental Act: trust-account payments "shall not earn interest unless the landlord and tenant agree in the vacation rental agreement", and the agreement must state to whom accrued interest is disbursed. CONTRACTUAL, not statutory — no default obligation. Applies to short-stay bookings.')
ON CONFLICT (state_code, effective_year, unit_types) DO NOTHING;

-- ── Illinois: widen to RV park spaces ────────────────────────────────────
-- One statute, one row: 765 ILCS 745/18 is filed identically under the mobile
-- home, manufactured home and RV park acts.
UPDATE state_deposit_interest_rates
   SET unit_types = ARRAY['mobile_home','rv_spot'],
       notes = notes || ' S604 correction: the identical section is filed under rv_park as well as mobile_home_park/manufactured_home_park, so the obligation covers RV spaces too. Originally scoped to mobile_home only, which would have under-paid RV tenants in 25+-space parks.'
 WHERE state_code = 'IL' AND effective_year = 2026 AND unit_types = ARRAY['mobile_home'];

-- ── New Jersey: sharpen the custody blocker ──────────────────────────────
UPDATE state_deposit_custody_rules
   SET notes = 'N.J.S.A. 46:8-19 (VERBATIM corpus text): landlords with 10+ rental units may invest in "shares of an insured money market fund established by an investment company BASED IN THIS STATE and registered under the Investment Company Act of 1940 ... whose shares are registered under the Securities Act of 1933". The in-state-investment-company requirement is materially narrower than a generic insured MMF and likely excludes GAM''s intended custodian. Under 10 units: an insured NJ bank at the rate currently paid on time or savings deposits. Resolve before NJ onboarding.',
       updated_at = now()
 WHERE state_code = 'NJ';

-- ── Provenance: NJ/SC were corpus-resident all along ─────────────────────
UPDATE state_deposit_interest_rates
   SET notes = notes || ' S604: confirmed VERBATIM against state_law_section_texts (act_key general_landlord_tenant) — the corpus held this section all along; the earlier gap was a query filter, not missing data.'
 WHERE state_code IN ('NJ','SC') AND effective_year = 2026;
