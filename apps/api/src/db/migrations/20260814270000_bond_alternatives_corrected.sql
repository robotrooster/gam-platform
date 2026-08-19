-- S604 correction + detail on what a bond actually buys.
--
-- DELAWARE — the earlier bond_alternative flag was WRONG. § 5514's bond language
-- is about a TENANT-provided surety bond counting toward the one-month deposit
-- cap ("which when combined with the amount of any surety bond is in excess of
-- 1 month's rent"). It is NOT a landlord-side substitute for the escrow account.
-- Delaware's escrow requirement stands with no bond escape.
--
-- What the real bond provisions permit:
--   MI § 554.604(1)  the only EXPRESS authorisation to use the funds: post a
--                    cash or surety bond with the secretary of state, acceptable
--                    to the attorney general, "to secure the entire deposits up
--                    to $50,000", and the landlord "may use the moneys so
--                    deposited for any purposes he desires".
--   GA § 44-7-32     "Surety bond IN LIEU OF escrow account", posted with the
--                    clerk of the superior court, in the amount of the deposits
--                    held or $50,000. Lifts the account requirement; SILENT on
--                    what may then be done with the money.
--   FL § 83.49(1)(c) bond with the clerk of the circuit court for the total
--                    deposits, then 5% simple interest to the tenant. An
--                    alternative to holding in an account at all.
--   NC § 42-50       bond from a licensed insurer as an alternative to the trust
--                    account, AND separately permits an OUT-OF-STATE trust
--                    account if an adequate bond is provided. Silent on use.
--
-- ⚠️ The $50,000 figure in MI and GA needs a closer read before either is relied
-- on at scale — if it caps the bond rather than the covered deposits, the
-- mechanism does not scale to a large portfolio in those states.

UPDATE state_deposit_custody_rules
   SET bond_alternative = false,
       bond_notes = 'S604 CORRECTION: no landlord-side bond alternative exists. § 5514''s bond language concerns a TENANT-provided surety bond counting toward the one-month deposit cap, not a substitute for the escrow account. The escrow requirement stands.',
       updated_at = now()
 WHERE state_code = 'DE';

UPDATE state_deposit_custody_rules
   SET bond_notes = 'The ONLY express authorisation found in any state to USE the funds: § 554.604(1) — post a cash or surety bond with the secretary of state, written by a surety licensed in Michigan and acceptable to the attorney general, "to secure the entire deposits up to $50,000", and the landlord "may use the moneys so deposited for any purposes he desires". VERIFY whether $50,000 caps the bond or the covered deposits before relying on this at scale.',
       updated_at = now()
 WHERE state_code = 'MI';

UPDATE state_deposit_custody_rules
   SET bond_notes = '§ 44-7-32 "Surety bond in lieu of escrow account", posted with the clerk of the superior court in the county of the dwelling unit, in the amount of the deposits held or $50,000. Lifts the ACCOUNT requirement but is SILENT on what may be done with the money — it does not affirmatively authorise investment the way Michigan does.',
       updated_at = now()
 WHERE state_code = 'GA';

UPDATE state_deposit_custody_rules
   SET bond_notes = '§ 42-50: a bond from an insurer licensed in North Carolina substitutes for the trust account. Separately, deposits MAY be held in a trust account OUTSIDE North Carolina if the tenant is given an adequate bond in the amount of the deposits — which is the cheaper route if the goal is simply to custody elsewhere. Silent on permitted use.',
       updated_at = now()
 WHERE state_code = 'NC';
