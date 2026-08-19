-- S604: custody rules RE-DERIVED after the act_key filter bug.
--
-- The first custody seeding was built from queries filtered to a hand-picked
-- act_key list, the same defect that made the interest sweep miss 16 states.
-- Re-swept with no act_key filter and every hit READ, not pattern-matched.
--
-- The picture is materially more restrictive than the first pass suggested.
-- Most states with any custody rule require a BANK / ESCROW / TRUST ACCOUNT at a
-- financial institution. A brokerage-held Treasury bill is not a deposit account
-- at a financial institution, so it fails those tests regardless of credit
-- quality. Treasuries are viable mainly where a state says NOTHING about custody.
--
-- Read this pass (citation → what it actually requires):
--   AK § 34.03.070  trust account in a bank, S&L, or licensed escrow agent;
--                   may not use one tenant's money for another's refund/rent
--   CO § 38-12-207  MOBILE HOME PARKS: "separate trust account ... as a private
--                   trustee", "shall not commingle the trust funds with other
--                   money" — pooling barred. Landlord MAY KEEP interest/profits
--                   "as compensation for administering the trust account"
--   DE § 5514       escrow bank account at a federally-insured banking institution
--   GA § 44-7-31    escrow account "established only for that purpose" at a bank
--                   or lending institution regulated by the state or the US
--   ID § 6-321      third-party agents (GAM's posture): separate account at a
--                   federally insured institution, apart from operating funds
--   KY § 383.580    separate account; tenant told its location and number
--   ME § 6038       bank/financial-institution account; may not be commingled
--                   with the assets of the landlord "or any other entity"
--   MO § 535.300    institution insured by a federal agency (landlord keeps interest)
--   OK § 115        escrow account maintained IN OKLAHOMA at a federally insured
--                   institution; misappropriation is criminal
--   WA § 59.18.270  trust account at a financial institution or licensed escrow
--                   agent LOCATED IN WASHINGTON
--   WA § 59.20.170  same rule for manufactured home parks
--   ND § 47-16-07.1 federally insured interest-bearing savings or checking
--   NC § 42-50      trust account at a licensed, federally insured depository —
--                   OR a bond, which is an alternative worth pricing
--
-- PERMISSIVE — expressly allow a COMMON (pooled) account, which is exactly
-- GAM's shape:
--   IA § 562A.12 / § 562B.13 and KS § 58-25,108: deposits "MAY be held in a
--   trust account, which MAY be a COMMON trust account and which MAY be an
--   interest bearing account" — permissive, not mandatory, and pooling is named.
--
-- NO CUSTODY RULE AT ALL (read and confirmed silent) — Treasuries lawful:
--   SC § 27-40-410, OR § 90.300 (separate ACCOUNTING only, no separate account),
--   AZ § 33-1321 / § 33-1431 / § 33-2121 (deposit caps, interest and 14-day
--   return, but no account requirement anywhere).
--
-- States NOT read on this pass stay ABSENT and therefore resolve to
-- needs_research — fail-closed is deliberate.

-- Reset the rows this migration is authoritative for, then re-insert. Earlier
-- rows were derived from the buggy filtered sweep and are not trustworthy.
DELETE FROM state_deposit_custody_rules
 WHERE state_code IN ('AK','AZ','CA','CO','CT','DE','FL','GA','IA','ID','IL','KS','KY','MA','MD',
                      'ME','MI','MO','NC','ND','NJ','NM','NV','NY','OH','OK','OR','PA','SC','VA','WA','WV');

INSERT INTO state_deposit_custody_rules
  (state_code, custody_status, allows_treasury_bills, requires_in_state_depository,
   requires_federally_insured, requires_interest_bearing, prohibits_use_of_funds,
   statute_citation, notes, researched_at)
VALUES
  -- ── Treasuries lawful: statute is silent on custody ────────────────────
  ('AZ', 'supported', true, false, false, false, false,
   'A.R.S. §§ 33-1321, 33-1431, 33-2121',
   'Read in full: deposit caps, the mobile-home 5% interest rule and the 14-day return, but NO account-type requirement of any kind. Treasuries lawful. (Oak Park sits here.)', '2026-08-14'),
  ('SC', 'supported', true, false, false, false, false, 'S.C. Code § 27-40-410',
   'No interest requirement and no segregated/escrow/in-state/interest-bearing account requirement. Paired with a `none` obligation, SC deposits are pure spread.', '2026-08-14'),
  ('OR', 'supported', true, false, false, false, false, 'Or. Rev. Stat. § 90.300',
   'Requires a separate ACCOUNTING for deposits and prepaid rent — NOT a separate account. No institution or account-type requirement.', '2026-08-14'),

  -- ── Pooling expressly permitted ───────────────────────────────────────
  ('IA', 'needs_research', false, false, false, false, false,
   'Iowa Code §§ 562A.12, 562B.13',
   'PERMISSIVE and unusually favourable: deposits "may be held in a trust account, which may be a COMMON trust account and which may be an interest bearing account" — a pooled account is expressly contemplated. Trust account is optional, not mandatory. Confirm whether a non-bank vehicle satisfies it before flipping to supported.', '2026-08-14'),
  ('KS', 'needs_research', false, false, false, false, false, 'Kan. Stat. § 58-25,108',
   'Same permissive shape as Iowa: "may be held in a trust account, which may be a common trust account and which may be an interest bearing account", and interest earned is the landlord''s. Confirm the vehicle question.', '2026-08-14'),

  -- ── Bank / escrow / trust account required ────────────────────────────
  ('AK', 'blocked', false, false, false, false, false, 'Alaska Stat. § 34.03.070',
   'Trust account at a bank, savings and loan, or licensed escrow agent (wherever practicable). Also bars using one tenant''s trust money for another tenant''s refund, rent or damages — read it before designing any pooled disbursement.', '2026-08-14'),
  ('CO', 'blocked', false, false, false, false, true, 'Colo. Rev. Stat. § 38-12-207',
   'MOBILE HOME PARKS: each deposit into a "separate trust account ... administered by the landlord as a private trustee", and "shall not commingle the trust funds with other money". POOLING IS BARRED. Upside: the landlord "may keep the interest and profits earned from the corpus as compensation", so nothing is owed the tenant.', '2026-08-14'),
  ('DE', 'blocked', false, false, true, false, false, 'Del. Code tit. 25 § 5514',
   'Escrow bank account at a federally-insured banking institution. A surety bond appears as an alternative in the deposit-limit provision — worth pricing.', '2026-08-14'),
  ('GA', 'blocked', false, true, true, false, false, 'Ga. Code § 44-7-31',
   'Escrow account "established only for that purpose" at a bank or lending institution regulated by this state or a US agency, held in trust for the tenant. Georgia also allows a surety bond alternative — the likely path if GAM wants GA.', '2026-08-14'),
  ('ID', 'blocked', false, false, true, false, false, 'Idaho Code § 6-321',
   'Deposits held by a THIRD-PARTY AGENT — which is GAM''s posture — must sit in a separate account at a federally insured financial institution, kept apart from the agent''s operating account. The carve-out is for owners/managers, not agents.', '2026-08-14'),
  ('KY', 'blocked', false, false, false, false, false, 'Ky. Rev. Stat. § 383.580',
   'Separate account required; the tenant must be told the account''s location and number — which implies a real, identifiable deposit account.', '2026-08-14'),
  ('ME', 'blocked', false, false, false, false, false, 'Me. Rev. Stat. tit. 14 § 6038',
   'Must be held at a bank or other financial institution and "may not be treated as an asset to be commingled with the assets of the landlord or any other entity or person" — the "any other entity" wording reaches a custodian like GAM.', '2026-08-14'),
  ('MO', 'blocked', false, false, true, false, false, 'Mo. Rev. Stat. § 535.300',
   'Must be held at an institution insured by an agency of the federal government. Interest earned is the LANDLORD''s, so the economics are good — the vehicle is the only obstacle.', '2026-08-14'),
  ('NC', 'blocked', false, true, true, false, false, 'N.C.G.S. § 42-50',
   'Trust account at a licensed and federally insured depository or trust institution authorised to do business in this State — OR the landlord may furnish a BOND from an insurer. The bond route is the realistic path for NC.', '2026-08-14'),
  ('ND', 'blocked', false, false, true, true, false, 'N.D. Cent. Code § 47-16-07.1',
   'Federally insured interest-bearing savings or checking account for the benefit of the tenant, and all accruing interest is the tenant''s.', '2026-08-14'),
  ('OK', 'blocked', false, true, true, false, false, 'Okla. Stat. tit. 41 § 115',
   'Escrow account maintained IN THE STATE OF OKLAHOMA at a federally insured institution. Misappropriation is a criminal offence — treat this state as strict.', '2026-08-14'),
  ('WA', 'blocked', false, true, false, false, false,
   'Wash. Rev. Code §§ 59.18.270, 59.20.170',
   'Trust account at a financial institution or licensed escrow agent LOCATED IN WASHINGTON. The identical rule applies to manufactured home parks under 59.20.170.', '2026-08-14'),
  ('FL', 'blocked', false, true, false, true, true, 'Fla. Stat. § 83.49',
   'Florida financial institution required, and the statute bars hypothecating, pledging or "in any other way" making use of the funds — the strictest wording found. Non-interest-bearing is one lawful option, in which case nothing is owed.', '2026-08-14'),
  ('NJ', 'needs_research', false, true, true, true, false, 'N.J.S.A. 46:8-19',
   'Money market fund permitted at 10+ units, but only one "established by an investment company BASED IN THIS STATE" — narrower than a generic insured MMF and likely excludes GAM''s custodian. Under 10 units: an insured NJ bank.', '2026-08-14'),
  ('NY', 'blocked', false, true, false, true, false, 'N.Y. Gen. Oblig. Law § 7-103',
   'Deposits in six-or-more-family dwellings must sit in a New York banking organisation in an interest-bearing account; landlord retains 1% per annum.', '2026-08-14'),
  ('PA', 'blocked', false, false, true, false, false, '68 P.S. § 250.511b',
   'Escrow account at an institution regulated by the Federal Reserve, FDIC or the Pennsylvania Department of Banking; interest-bearing once held beyond two years.', '2026-08-14'),
  ('MA', 'blocked', false, false, true, true, false, 'Mass. G.L. c. 186 § 15B',
   'Deposits must be held in a separate interest-bearing account in a Massachusetts bank; the lesser-of interest rule is expressly measured by what "has been received FROM THE BANK", which presupposes a bank deposit account.', '2026-08-14'),
  ('MD', 'supported', true, true, true, false, false, 'Md. Code, Real Prop. § 8-203',
   'The one state read so far that expressly permits securities: insured CDs at in-state branches OR "securities issued by the federal government or the State of Maryland". Treasuries lawful.', '2026-08-14'),
  ('CT', 'needs_research', false, false, true, false, false, 'Conn. Gen. Stat. § 47a-21',
   'Escrow/custody provisions in a long section not yet read in full; the interest side is index-linked and covers mobile manufactured homes and parks as well as residential.', '2026-08-14'),
  ('IL', 'needs_research', false, false, false, false, false, '765 ILCS 745/18',
   'Interest obligation confirmed for mobile home AND RV parks of 25+ spaces; the custody/account side has not been read in full.', '2026-08-14'),
  ('VA', 'needs_research', false, false, false, false, false, 'Va. Code § 55.1-1205',
   'No deposit-interest obligation, but an escrow-account provision exists for PREPAID RENT (§ 55.1-1205) that has not been read in full.', '2026-08-14'),
  ('CA', 'needs_research', false, false, false, false, false, 'Cal. Civ. Code § 798.39',
   'Mobile home deposits owe no interest and need not sit in an interest-bearing account. The general residential custody position (Civ. Code § 1950.5) has not been read.', '2026-08-14'),
  ('NV', 'needs_research', false, false, false, false, false, 'Nev. Rev. Stat. § 118B.150',
   'Manufactured home parks: landlord need not place the deposit in a financial institution or pay interest — favourable. General residential custody not yet read.', '2026-08-14'),
  ('MI', 'needs_research', false, true, false, false, false, NULL,
   'In-state institution language seen in the corpus; section not read in full.', '2026-08-14'),
  ('NM', 'needs_research', false, false, false, false, false, NULL,
   'Custody language seen in the corpus; section not read in full.', '2026-08-14'),
  ('OH', 'needs_research', false, false, false, false, false, NULL,
   'Prior flag came from § 4781.25, which governs manufactured-housing BROKER trust accounts, not landlord deposits. The landlord-side position has not been established.', '2026-08-14'),
  ('WV', 'needs_research', false, false, false, false, false, NULL,
   'Custody language seen in the corpus; section not read in full.', '2026-08-14');
