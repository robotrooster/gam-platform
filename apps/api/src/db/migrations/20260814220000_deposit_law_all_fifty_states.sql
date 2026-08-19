-- S604: ALL 50 STATES read, per (state, ACT). Not per state — Arizona alone has
-- four tenancy acts and they disagree with each other.
--
-- Method: enumerate every (state, act_key) pair with deposit-bearing sections
-- (~100 pairs, 49 states; WY has none), then READ them. Keyword triage was
-- abandoned after it produced false results in BOTH directions on this very
-- pass:
--   • called TN "clean" — TN § 66-28-301(a) requires a dedicated bank account
--   • called NM "clean" — NM § 47-8-18 owes passbook interest above 1 month rent
--   • called PA/RI "clean" — both already known to have obligations
--   • flagged OH from § 4781.25, which governs manufactured-housing BROKER
--     trust accounts; Ohio's real landlord rule (§ 5321.16) is a 5% obligation
--     that the keyword pass never surfaced.
--
-- NEW DIMENSION — threshold rules. Two states condition the obligation on
-- deposit SIZE, and they do it differently:
--   OHIO § 5321.16(A): interest at 5% "on the EXCESS" over fifty dollars or one
--     month's periodic rent, whichever is greater, and only if the tenant stays
--     six months or more. Only the excess earns.
--   NEW MEXICO § 47-8-18(A)(1): if the deposit exceeds one month's rent, the
--     owner pays passbook interest "on such deposit" — the WHOLE deposit earns,
--     the size is only a trigger. Under a lease shorter than a year the deposit
--     is capped at one month, so the obligation cannot arise.
-- Encoding both as one flat rate would over-pay Ohio and under-pay New Mexico.

ALTER TABLE state_deposit_interest_rates
  ADD COLUMN IF NOT EXISTS threshold_rule            text,
  ADD COLUMN IF NOT EXISTS threshold_amount          numeric(10,2),
  ADD COLUMN IF NOT EXISTS threshold_months_rent     numeric(5,2);

ALTER TABLE state_deposit_interest_rates DROP CONSTRAINT IF EXISTS sdir_threshold_check;
ALTER TABLE state_deposit_interest_rates
  ADD CONSTRAINT sdir_threshold_check
  CHECK (threshold_rule IS NULL OR threshold_rule IN ('trigger','excess_only'));

COMMENT ON COLUMN state_deposit_interest_rates.threshold_rule IS
  'S604: NULL = whole deposit always earns. trigger = whole deposit earns only once it exceeds the threshold (NM). excess_only = only the amount ABOVE the threshold earns (OH).';
COMMENT ON COLUMN state_deposit_interest_rates.threshold_amount IS
  'S604: dollar leg of the threshold. When both this and threshold_months_rent are set, the statute takes WHICHEVER IS GREATER (OH: $50 or one month rent).';

-- ── OHIO — the miss the keyword pass hid ─────────────────────────────────
INSERT INTO state_deposit_interest_rates
  (state_code, effective_year, annual_rate_pct, statute_citation, unit_types,
   act_key, rate_basis, min_tenure_months, threshold_rule, threshold_amount,
   threshold_months_rent, notes)
VALUES
  ('OH', 2026, 5.0000, 'Ohio Rev. Code § 5321.16(A)', '{}', 'general_real_property',
   'fixed', 6, 'excess_only', 50.00, 1.00,
   'FIXED 5% — the third state that can run negative against market yield, after AZ and RI. Applies ONLY to the portion above fifty dollars or one month periodic rent, whichever is GREATER, and only once the tenant has remained in possession six months or more. Computed and paid ANNUALLY. The earlier OH flag came from § 4781.25 (manufactured-housing BROKER trust accounts) and was unrelated to landlord deposits.'),
  ('NM', 2026, 0.0000, 'N.M. Stat. § 47-8-18(A)(1)', '{}', 'residential',
   'index_linked', NULL, 'trigger', NULL, 1.00,
   'Owed only where the deposit EXCEEDS one month rent under an ANNUAL rental agreement; then the whole deposit earns "interest equal to the passbook interest permitted to savings and loan associations in this state by the federal home loan bank board", paid annually. Under a lease shorter than one year the deposit is capped at one month rent, so the obligation cannot arise. REFRESH the passbook index annually.'),
  ('TN', 2026, 0.0000, 'Tenn. Code § 66-28-301', '{}', 'residential',
   'none', NULL, NULL, NULL, NULL,
   'No interest obligation, but a DEDICATED ACCOUNT is required — see custody rules. Keyword triage wrongly reported Tennessee as having no provisions at all.')
ON CONFLICT (state_code, effective_year, unit_types) DO NOTHING;

-- ── Every remaining state: read, owes nothing, full spread to GAM ────────
-- Recorded explicitly rather than left absent, so "no row" never has to be
-- guessed at again.
INSERT INTO state_deposit_interest_rates
  (state_code, effective_year, annual_rate_pct, statute_citation, unit_types,
   act_key, rate_basis, notes)
SELECT s, 2026, 0.0000, cite, '{}', 'residential', 'none', note
FROM (VALUES
  ('AL','Ala. Code § 35-9A-201','Deposit cap and return only; no interest, no account requirement.'),
  ('AR','Ark. Code § 18-16-304','Cap of two months rent; no interest, no account requirement.'),
  ('HI','Haw. Rev. Stat. § 521-44','Deposit uses, cap and return; the only "interest" language is a successor''s interest in the dwelling unit. No obligation.'),
  ('IN','Ind. Code § 32-31-3','Return and itemisation only; no interest, no account requirement.'),
  ('LA','La. Rev. Stat. § 9:3251','One-month return and itemisation; no interest, no account requirement.'),
  ('MS','Miss. Code § 89-8-21','Deposit "shall be held by the landlord for the tenant"; no account type specified and no interest.'),
  ('MT','Mont. Code § 70-25-201 et seq.','Residential Tenants Security Deposit Act: deductions, list and refund. No interest, no account requirement.'),
  ('NE','Neb. Rev. Stat. § 76-1416','Cap of one month rent (plus limited pet deposit); no interest, no account requirement.'),
  ('SD','S.D. Codified Laws §§ 43-32-6.1, 43-32-24','Cap of one month rent absent special conditions; two-week return. No interest, no account requirement.'),
  ('UT','Utah Code § 57-17-1 et seq.','Deposit application and 30-day return; no interest, no account requirement.'),
  ('VT','Vt. Stat. tit. 9 § 4461','Definition, permitted retentions and return; no interest, no account requirement.'),
  ('WI','Wis. Stat. § 704.28','Withholding provisions and return; no interest, no account requirement.'),
  ('WV','W. Va. Code § 37-6A-2','Return and itemisation; no interest, no account requirement.'),
  ('TX','Tex. Prop. Code §§ 92.101-92.109','Largest rental market in the country and among the most permissive: no interest obligation and NO account requirement anywhere in the residential or manufactured-home-park chapters.'),
  ('WY','Wyo. Stat. tit. 1 ch. 21','No deposit-bearing tenancy provisions in the corpus at all.'),
  ('KS','Kan. Stat. § 58-2550','Residential: cap and return only, no interest. (Mobile home parks under § 58-25,108 expressly give any interest earned to the landlord.)'),
  ('OK','Okla. Stat. tit. 41 § 115','No interest obligation. Custody IS restricted — in-state escrow, see custody rules.'),
  ('AK','Alaska Stat. § 34.03.070','No interest obligation. Custody IS restricted — trust account, see custody rules.'),
  ('CO','Colo. Rev. Stat. § 38-12-103','No interest obligation to the tenant. Under the mobile home park act § 38-12-207 the landlord expressly "may keep the interest and profits earned from the corpus".'),
  ('DE','Del. Code tit. 25 § 5514','No interest obligation. Custody IS restricted — escrow at a federally-insured institution.'),
  ('GA','Ga. Code § 44-7-31','No interest obligation. Custody IS restricted — escrow account, bond alternative available.'),
  ('ID','Idaho Code § 6-321','No interest obligation. Custody IS restricted for third-party agents.'),
  ('KY','Ky. Rev. Stat. § 383.580','No interest obligation. Custody IS restricted — separate account disclosed to tenant.'),
  ('ME','Me. Rev. Stat. tit. 14 § 6038','No interest obligation. Custody IS restricted — no commingling with any other entity''s assets.'),
  ('MI','Mich. Comp. Laws § 554.604','No interest obligation. Custody restricted BUT a cash or surety bond filed with the secretary of state lets the landlord "use the moneys so deposited for any purposes he desires".'),
  ('WA','Wash. Rev. Code § 59.18.270','No interest obligation. Custody IS restricted — in-state trust account.'),
  ('NV','Nev. Rev. Stat. §§ 118A.242, 118B.150','No interest obligation; manufactured home parks expressly need not place the deposit in a financial institution or pay interest.')
) AS v(s, cite, note)
ON CONFLICT (state_code, effective_year, unit_types) DO NOTHING;

-- ── Custody: states read this pass with NO account requirement ───────────
INSERT INTO state_deposit_custody_rules
  (state_code, custody_status, allows_treasury_bills, requires_in_state_depository,
   requires_federally_insured, requires_interest_bearing, prohibits_use_of_funds,
   statute_citation, notes, researched_at)
SELECT s, 'supported', true, false, false, false, false, cite, note, '2026-08-14'
FROM (VALUES
  ('TX','Tex. Prop. Code §§ 92.101-92.109','Read in full: zero sections in the residential or manufactured-home-park chapters mention a trust account, escrow, separate account, federally insured institution, commingling or interest. Largest rental market in the country, fully open.'),
  ('AL','Ala. Code § 35-9A-201','No account requirement.'),
  ('AR','Ark. Code § 18-16-304','No account requirement.'),
  ('HI','Haw. Rev. Stat. § 521-44','No account requirement.'),
  ('IN','Ind. Code § 32-31-3','No account requirement.'),
  ('LA','La. Rev. Stat. § 9:3251','No account requirement.'),
  ('MS','Miss. Code § 89-8-21','Held "for the tenant" with no account type specified.'),
  ('MT','Mont. Code § 70-25-201 et seq.','No account requirement.'),
  ('NE','Neb. Rev. Stat. § 76-1416','No account requirement.'),
  ('SD','S.D. Codified Laws § 43-32-6.1','No account requirement.'),
  ('UT','Utah Code § 57-17-1 et seq.','No account requirement.'),
  ('VT','Vt. Stat. tit. 9 § 4461','No account requirement.'),
  ('WI','Wis. Stat. § 704.28','No account requirement.'),
  ('WV','W. Va. Code § 37-6A-2','No account requirement.'),
  ('WY','n/a','No deposit-bearing tenancy provisions in the corpus.'),
  ('CA','Cal. Civ. Code § 1950.5; § 798.39','No account requirement found in either the residential or mobilehome provisions; mobilehome deposits expressly need not be interest-bearing.'),
  ('NV','Nev. Rev. Stat. §§ 118A.242, 118B.150','No account requirement; manufactured home parks expressly need not use a financial institution.'),
  ('NM','N.M. Stat. § 47-8-18','No account requirement (the obligation is an interest one, above one month rent).')
) AS v(s, cite, note)
ON CONFLICT (state_code) DO NOTHING;

-- ── Custody: states read this pass WITH an account requirement ───────────
INSERT INTO state_deposit_custody_rules
  (state_code, custody_status, allows_treasury_bills, requires_in_state_depository,
   requires_federally_insured, requires_interest_bearing, prohibits_use_of_funds,
   statute_citation, notes, researched_at)
VALUES
  ('TN', 'blocked', false, false, true, false, false, 'Tenn. Code § 66-28-301(a)',
   'Deposits must sit "in an account used only for that purpose, in any bank or other lending institution subject to regulation by the state or any agency of the United States government." A dedicated deposit account — a brokerage T-bill position does not satisfy it.',
   '2026-08-14'),
  ('MI', 'blocked', false, false, false, false, false, 'Mich. Comp. Laws § 554.604',
   'Default is a regulated financial institution — BUT § 554.604(1) expressly allows the landlord to "use the moneys so deposited for any purposes he desires" on filing a cash or surety bond with the secretary of state. The BOND ROUTE unlocks full use of the funds and is the most permissive workaround found in any state.',
   '2026-08-14')
ON CONFLICT (state_code) DO UPDATE
  SET custody_status = EXCLUDED.custody_status,
      allows_treasury_bills = EXCLUDED.allows_treasury_bills,
      statute_citation = EXCLUDED.statute_citation,
      notes = EXCLUDED.notes,
      researched_at = EXCLUDED.researched_at,
      updated_at = now();

-- OH custody: the prior flag was the broker section. Landlord side imposes no
-- account requirement — only the § 5321.16 interest duty now recorded above.
UPDATE state_deposit_custody_rules
   SET custody_status = 'supported', allows_treasury_bills = true,
       statute_citation = 'Ohio Rev. Code § 5321.16',
       notes = 'Landlord side imposes NO account requirement. The earlier "in this state" trust-account flag came from § 4781.25, which governs manufactured-housing BROKER trust accounts — unrelated to landlord-held deposits. Ohio does owe 5% interest on the excess over the greater of $50 or one month rent after six months tenancy.',
       researched_at = '2026-08-14', updated_at = now()
 WHERE state_code = 'OH';

-- VA custody: the escrow language concerns PREPAID RENT and insurance fees
-- (§ 55.1-1205/1206), not security deposits.
UPDATE state_deposit_custody_rules
   SET custody_status = 'supported', allows_treasury_bills = true,
       notes = 'No security-deposit account requirement. § 55.1-1205 escrow language governs PREPAID RENT, and § 55.1-1206 concerns damage-insurance fees — neither reaches security deposits. VRLTA owes no deposit interest.',
       researched_at = '2026-08-14', updated_at = now()
 WHERE state_code = 'VA';

-- WV custody: nothing found on a full read.
UPDATE state_deposit_custody_rules
   SET custody_status = 'supported', allows_treasury_bills = true,
       statute_citation = 'W. Va. Code § 37-6A-2',
       notes = 'Read in full: return and itemisation only. No account requirement, no interest.',
       researched_at = '2026-08-14', updated_at = now()
 WHERE state_code = 'WV';
