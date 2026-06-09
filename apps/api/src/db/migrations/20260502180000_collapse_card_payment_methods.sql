-- 16a Step 2 schema addendum: collapse card_credit + card_debit → card
-- Single 'card' bucket simplifies allocation engine. Margin varies per
-- card type but GAM still profits on both. Re-split is a 5-minute migration
-- if differentiated tenant-facing pricing ever becomes a product requirement.

-- DELETE first so the new CHECK doesn't fail validation on existing rows.
-- Safe because all rate fields are NULL (engine refuses to run anyway).
DELETE FROM platform_processing_rates;

-- Drop+re-add CHECK with collapsed value set
ALTER TABLE platform_processing_rates
  DROP CONSTRAINT platform_processing_rates_payment_method_check;

ALTER TABLE platform_processing_rates
  ADD CONSTRAINT platform_processing_rates_payment_method_check
    CHECK (payment_method IN ('ach', 'card'));

-- Reseed clean
INSERT INTO platform_processing_rates (payment_method, notes) VALUES
  ('ach',  'Placeholder. Set rates before enabling rent allocation.'),
  ('card', 'Placeholder. Set rates before enabling rent allocation.');
