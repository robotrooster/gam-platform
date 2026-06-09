-- S116: drop the deprecated banking_fee_payer column from
-- property_allocation_rules.
--
-- S114 added ach_fee_payer + card_fee_payer + platform_fee_payer (three
-- independent per-property toggles) and backfilled them from the legacy
-- banking_fee_payer. S116 refactored allocation.ts and routes/properties.ts
-- to read/write the three new fields. The legacy column is now dead in
-- the live codebase.
--
-- The route still accepts a legacy `banking_fee_payer` BODY field for
-- backward compat (mirrors into ach + card when the new fields aren't
-- supplied) but never writes it to the column. Safe to drop.

ALTER TABLE property_allocation_rules
  DROP CONSTRAINT property_allocation_rules_banking_fee_payer_check;

ALTER TABLE property_allocation_rules
  DROP COLUMN banking_fee_payer;
