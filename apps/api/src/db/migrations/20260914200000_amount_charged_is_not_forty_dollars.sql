-- S642 (Nic): "I don't know what the $40 is, but let's get it fixed because
-- that's not the real price… All the money needs to reflect what actually
-- happened."
--
-- background_checks.amount_charged carried DEFAULT 40.00 from the original
-- schema. Nothing has ever written the column and nothing reads it, so every
-- row ever created shows $40.00 — a figure that looks like a price, is not one,
-- and never matched a charge. The one real screening on file was charged $44.99
-- (Stripe: pi_3UC0W4DNEru9AEpK1UX48y8o, 4499 received) while its row said 40.00.
--
-- The route now writes the cents Stripe actually captured. Two changes here so
-- the stored history cannot keep lying:
--
--   1. Drop the default. An amount nobody recorded must read as UNKNOWN, not as
--      forty dollars. A NULL cannot be mistaken for a real figure; 40.00 can,
--      and would quietly understate screening revenue in the first report
--      anybody writes off this column.
--
--   2. Null the placeholders. Every surviving 40.00 is the default showing
--      through rather than a charge, so it is erased rather than preserved —
--      this is not [[gam-data-retention-keep-everything]] territory, because
--      there is no recorded event to keep. Real amounts are restored from Stripe
--      separately.

ALTER TABLE background_checks ALTER COLUMN amount_charged DROP DEFAULT;

UPDATE background_checks
   SET amount_charged = NULL
 WHERE amount_charged = 40.00;

COMMENT ON COLUMN background_checks.amount_charged IS
  'USD actually captured by Stripe for this screening, written at submit from the verified PaymentIntent. NULL means no amount was recorded — never assume a price.';
