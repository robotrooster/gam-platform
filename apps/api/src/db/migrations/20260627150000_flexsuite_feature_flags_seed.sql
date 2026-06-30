-- FlexSuite + OTP feature-flag rows — ensure they EXIST and are OFF (Nic 2026-06-27).
--
-- WHY: the products are "ready but hidden, flip on soon." Hiding relies on
-- system_features rows resolving to FALSE, and flipping on relies on the rows
-- EXISTING (the super-admin toggle + isFeatureEnabled both key off a real row;
-- a missing row silently reads FALSE and can't be listed/toggled in the admin UI).
-- The dev DB currently has ZERO system_features rows (rebuilt from the schema.sql
-- snapshot, which carries table DDL but not the seed INSERTs from the original
-- flag migrations). This restores them.
--
-- Also seeds the NEW flexcredit_rollout_visible flag (FlexCredit had no flag at
-- all — its enrollment endpoint is now gated on it).
--
-- ON CONFLICT (key) DO NOTHING: never clobbers a value an admin already set
-- (prod-safe); only fills in missing rows, all OFF. No backfill of other tables.

INSERT INTO system_features (key, enabled, description) VALUES
  ('flexpay_rollout_visible', FALSE,
   'FlexPay (payment-date coordination subscription). Hidden at launch; flip ON when cleared for go-live.'),
  ('flexdeposit_rollout_visible', FALSE,
   'FlexDeposit (deposit custody installments). Hidden at launch; flip ON when cleared for go-live.'),
  ('flexcharge_rollout_visible', FALSE,
   'FlexCharge (per-Location charge accounts). Hidden at launch; flip ON when cleared for go-live. NOTE: landlord frontend also gated by LAUNCH_HIDDEN and POS by LAUNCH_HIDE_CHARGE.'),
  ('flexcredit_rollout_visible', FALSE,
   'FlexCredit (rent-payment credit reporting via Esusu). NOT built — vendor-blocked. Keep OFF until the Esusu integration + billing ship.'),
  ('otp_rollout_visible', FALSE,
   'OTP (On-Time Pay rent advance). Hidden at launch. When TRUE, landlords with otp_rollout_enabled=TRUE see OTP surfaces.')
ON CONFLICT (key) DO NOTHING;
