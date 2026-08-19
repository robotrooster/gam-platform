-- S604 (Nic): the zero-spread states flip under a BANK CHARTER.
--
-- MA / NH / NJ each peg the TENANT's entitlement to what the INSTITUTION PAYS,
-- not to what it earns:
--   MA § 15B      "such lesser amount of interest as has been RECEIVED FROM THE
--                 BANK where the deposit has been held"
--   NH § 540-A:6  "a rate equal to the interest rate PAID ON REGULAR SAVINGS
--                 ACCOUNTS in the New Hampshire bank ... in which it is deposited"
--   NJ § 46:8-19  "The interest or earnings PAID THEREON BY the investment
--                 company, State or federally chartered bank ..."
--
-- That is the deposit rate, not the asset yield. A bank pays depositors one rate
-- and earns another on the assets those deposits fund; the net interest margin
-- belongs to the bank and no statute here reaches it. So "zero spread" is true
-- only while GAM is a CUSTODIAN at someone else's bank. As the bank operator,
-- GAM earns normally in all three and the tenant still receives the stated
-- account rate.
--
-- The charter does NOT cure the geography test: NH still requires an institution
-- "organized under the laws of this state" (a national charter fails), NJ an
-- entity "based in this State", MA a bank "located within the commonwealth".
-- The charter changes the economics once present; it does not grant presence.

UPDATE state_deposit_custody_rules
   SET notes = notes || ' S604 BANK-CHARTER NOTE: the tenant''s entitlement here is pegged to what the INSTITUTION PAYS (deposit rate), not what it earns. Under a GAM bank charter the net interest margin would be GAM''s and this state stops being zero-spread. The geography/charter test still has to be satisfied separately.',
       updated_at = now()
 WHERE state_code IN ('MA','NH','NJ');
