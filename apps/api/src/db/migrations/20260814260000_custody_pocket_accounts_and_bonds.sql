-- S604: two more dimensions, so the map answers "what if we change the vehicle?"
-- without re-reading 50 states each time.
--
--   qualifies_with_segregated_account — would this state be satisfied by a
--     PER-TENANT account at an FDIC-insured national bank (Jiko "pocket
--     accounts": individually titled, KYC'd, custodian-administered)?
--     This is a different question from the current brokerage-T-bill vehicle.
--     The statutes almost universally contemplate exactly this shape — a trust
--     or escrow account per tenant at an insured institution — so it clears
--     every state whose only test is the INSTITUTION, and it additionally
--     clears Colorado, whose bar is the opposite (it REQUIRES separation).
--     It does NOT cure a physical-office or state-charter requirement: a
--     national bank without an office in Connecticut is still not "located in
--     this state".
--
--   bond_alternative — several states let a bond substitute for the account
--     entirely, which is often the cheapest way into an otherwise hard state.
--     MI is the most permissive found anywhere: post the bond and the landlord
--     "may use the moneys so deposited for any purposes he desires".
--
-- FLORIDA CORRECTION (Nic): calling FL "blocked, investing barred" was wrong.
-- An interest-bearing account IS an investment, and § 83.49(1)(b) expressly
-- permits one. The "hypothecate, pledge, or in any other way make use of" bar
-- prohibits the landlord APPROPRIATING or LEVERAGING the funds — not the
-- institution paying interest on them. Florida offers three lawful routes:
--   (a) non-interest-bearing Florida account — owe nothing, earn nothing
--   (b) interest-bearing Florida account — tenant gets >=75% of the actual rate
--       OR 5% simple, landlord's election. Best economics: elect the 75% share
--       and keep 25%.
--   (c) SURETY BOND with the clerk of the circuit court for the full deposit
--       amount — then pay the tenant 5% per year simple interest. Frees the
--       cash entirely but 5% is above market, so it runs negative.

ALTER TABLE state_deposit_custody_rules
  ADD COLUMN IF NOT EXISTS qualifies_with_segregated_account boolean,
  ADD COLUMN IF NOT EXISTS bond_alternative                  boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS bond_notes                        text;

COMMENT ON COLUMN state_deposit_custody_rules.qualifies_with_segregated_account IS
  'S604: would a per-tenant account at an FDIC-insured national bank (Jiko pocket accounts, GAM-controlled disbursement) satisfy this state? NULL = supported already / not applicable.';

-- Institution-only tests + Colorado's separation requirement: pocket accounts work.
UPDATE state_deposit_custody_rules
   SET qualifies_with_segregated_account = true, updated_at = now()
 WHERE geography_test IN ('none','doing_business') OR state_code = 'CO';

-- Physical-office and state-charter tests survive a change of vehicle.
UPDATE state_deposit_custody_rules
   SET qualifies_with_segregated_account = false, updated_at = now()
 WHERE geography_test IN ('physical_office','state_chartered');

-- ── Bond alternatives ────────────────────────────────────────────────────
UPDATE state_deposit_custody_rules SET bond_alternative = true, bond_notes =
  'STRONGEST FOUND: § 554.604(1) — on filing a cash or surety bond with the secretary of state the landlord "may use the moneys so deposited for any purposes he desires". A bond converts Michigan from an account-restricted state to an unrestricted one.',
  updated_at = now() WHERE state_code = 'MI';
UPDATE state_deposit_custody_rules SET bond_alternative = true, bond_notes =
  '§ 42-50: the landlord may "furnish a bond from an insurer" INSTEAD of the trust account.',
  updated_at = now() WHERE state_code = 'NC';
UPDATE state_deposit_custody_rules SET bond_alternative = true, bond_notes =
  'A surety bond appears as an alternative alongside the escrow-account requirement.',
  updated_at = now() WHERE state_code IN ('GA','DE');
UPDATE state_deposit_custody_rules SET bond_alternative = true, bond_notes =
  '§ 83.49(1)(c): post a surety bond with the clerk of the circuit court for the total amount of the deposits, then pay the tenant 5% per year simple interest. Frees the cash but 5% is ABOVE market — negative spread. Option (b), an interest-bearing Florida account paying >=75% of actual, has better economics.',
  updated_at = now() WHERE state_code = 'FL';

-- Florida: correct the overstated "investing barred" characterisation.
UPDATE state_deposit_custody_rules
   SET prohibits_use_of_funds = false,
       institution_test = '"a Florida financial institution" for options (a) and (b). The "hypothecate, pledge, or in any other way make use of" bar prohibits the landlord APPROPRIATING or LEVERAGING the funds — it does NOT bar an interest-bearing account, which § 83.49(1)(b) expressly permits. Three lawful routes: (a) non-interest-bearing FL account; (b) interest-bearing FL account, tenant gets >=75% of actual or 5% simple at the landlord''s election; (c) surety bond with the clerk plus 5% simple to the tenant.',
       notes = 'Requires a Florida institution for the account routes; a bond frees the cash entirely. Best economics is (b) electing the 75% share — structurally positive, GAM keeps 25%.',
       updated_at = now()
 WHERE state_code = 'FL';
