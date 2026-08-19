-- S604: New York's custody requirement is scoped to SIX-OR-MORE-family dwellings.
--
-- § 7-103: "...six or more family dwelling units, the person receiving such money
-- shall ... deposit it in an interest bearing account in a banking organization
-- WITHIN THE STATE..." Below six units the general trust duty applies (the money
-- stays the tenant's, held in trust, not commingled) but NO institution or
-- geography is specified.
--
-- So New York is not uniformly blocked — most single-family and small
-- multifamily rentals there carry no account restriction. Recorded on the rule
-- so the onboarding flag can eventually be scoped by property size rather than
-- treating every NY landlord as restricted.

UPDATE state_deposit_custody_rules
   SET notes = notes || ' S604 SCOPE: the in-state banking-organization requirement applies ONLY to dwellings of SIX OR MORE family units. Under six units there is a trust duty but no named institution or geography — those properties are effectively unrestricted. The 1% administrative retention under § 7-103 likewise attaches to the interest-bearing-account case.',
       institution_test = institution_test || ' SCOPED: six-or-more-family dwellings only.',
       updated_at = now()
 WHERE state_code = 'NY';
