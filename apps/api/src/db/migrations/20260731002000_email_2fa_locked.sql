-- S571 — email-2FA "locked on" flag.
-- Tenant 2FA is email-code only (no authenticator). It becomes MANDATORY once
-- the tenant saves a payment method (ACH or card): `email_2fa_enabled` flips
-- TRUE and `email_2fa_locked` flips TRUE so the tenant cannot turn it back off
-- while a payment method is on file (there is no payment-method removal path
-- today, so once locked it stays locked). A tenant with NO payment method may
-- still enable email 2FA voluntarily (enabled=TRUE, locked=FALSE) and disable it.
--
-- The 2FA code always goes to the LOGIN email (users.email) — there is no
-- separate 2FA-email column, so changing the login email changes the 2FA
-- destination automatically (Nic's "cannot be different sources" rule).
--
-- No backfill needed: existing rows default to FALSE; the next payment-method
-- save locks them.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS email_2fa_locked boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.users.email_2fa_locked IS 'S571: when true, email 2FA is mandatory (a payment method is on file) and the user cannot self-disable it. Set alongside email_2fa_enabled at payment-method save.';
