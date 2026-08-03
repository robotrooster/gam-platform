-- S571 (Nic) — email 2FA is MANDATORY for every tenant, always, from signup.
-- Simpler than the payment-method-conditional model: a tenant's private lease
-- data warrants a second factor no matter what, and they add a payment method
-- on signup anyway. Login enforces it for all tenants (auth.ts) and
-- canonicalizes the flag on first sign-in; this backfills existing tenants so
-- the flag matches reality for the Profile → Security status card.
UPDATE users SET email_2fa_enabled = TRUE WHERE role = 'tenant' AND email_2fa_enabled = FALSE;

-- Drop the short-lived `email_2fa_locked` flag (added earlier this session for
-- the conditional model). Under universal mandatory 2FA there is no self-
-- disable, so nothing reads it. Safe drop — never shipped, no consumers remain.
ALTER TABLE users DROP COLUMN IF EXISTS email_2fa_locked;
