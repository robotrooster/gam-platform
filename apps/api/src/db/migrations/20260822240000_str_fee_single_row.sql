-- S616: collapse the fee config back to ONE row at 3%.
--
-- The previous migration closed a 5% period and opened a 3% one, preserving
-- history. Nic: "We are pre-launch. Nothing was ever booked at the five
-- percent." Verified — zero accruals carry an str_fee_amount. There is no
-- history to preserve, so the two-row version was ceremony over data that does
-- not exist.
DELETE FROM platform_fee_config WHERE effective_until IS NOT NULL;

UPDATE platform_fee_config
   SET str_fee_pct = 0.0300,
       notes = 'Launch: $2/occupied unit, $10/property min, 3% STR revenue.'
 WHERE effective_until IS NULL;
