-- security_deposits.custody_fee_active — custody-fee dissolve on transfer (S516).
--
-- WHY. Consumer ToS § 9.1.6: when a FlexDeposit deposit is forwarded to
-- another GAM property, the $3/mo custody fee dissolves once the deposit is
-- fully funded into the new property's custody. Nic's rule:
--   - forward with no top-up, OR top-up paid in a single pull  → fee STOPS
--   - forward where the top-up is taken as installments         → fee CONTINUES
-- The base FlexDeposit deposit charges the fee for as long as GAM holds it,
-- so this flag defaults TRUE; the forwarding flow flips it FALSE in the
-- lump / no-top-up case. The custody-fee cron filters on it.
--
-- No backfill needed: TRUE matches existing behavior for all current rows.

ALTER TABLE security_deposits
  ADD COLUMN custody_fee_active boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN security_deposits.custody_fee_active IS
  'S516: while TRUE the $3/mo FlexDeposit custody fee is billed. Set FALSE when a forwarded deposit is fully funded via a lump top-up or needed no top-up (ToS § 9.1.6).';
