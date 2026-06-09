-- S410 (S377 Nic-locked decision): split the overloaded
-- `users.email_verify_token` column into three purpose-scoped columns.
--
-- Pre-fix, ONE column served three distinct purposes:
--   1. Email verification (auth.ts /verify-email)
--   2. Tenant invite token (tenants.ts /invite + esign.ts resume URL)
--   3. Landlord invite token (landlords.ts admin create / re-invite)
--
-- Risk: a tenant invite token could in principle match a stale
-- email-verification flow on a different user (random tokens, low
-- collision probability — but the conceptual overlap was the security
-- smell). Splitting also enables per-purpose expiry windows and
-- isolated revocation.
--
-- Plus: invite tokens now have a 7-day expiry (S377 (b) decision).
-- email_verify_token also gains its own expires_at for symmetry —
-- the accept routes enforce expires_at > NOW().
--
-- Pre-launch posture: no backfill of existing email_verify_token data
-- into the new columns. Dev seed data is acceptable to leave behind;
-- the existing column is left in place for its remaining
-- email-verification role.

ALTER TABLE users
  ADD COLUMN tenant_invite_token text,
  ADD COLUMN tenant_invite_expires_at timestamptz,
  ADD COLUMN landlord_invite_token text,
  ADD COLUMN landlord_invite_expires_at timestamptz,
  ADD COLUMN email_verify_token_expires_at timestamptz;

-- Partial unique indexes so duplicate tokens can't collide across
-- users (token is a random string; uniqueness is a defensive
-- invariant even with crypto-strength entropy).
CREATE UNIQUE INDEX ux_users_tenant_invite_token
  ON users (tenant_invite_token) WHERE tenant_invite_token IS NOT NULL;
CREATE UNIQUE INDEX ux_users_landlord_invite_token
  ON users (landlord_invite_token) WHERE landlord_invite_token IS NOT NULL;

COMMENT ON COLUMN users.tenant_invite_token IS
  'S410/S377: separate from email_verify_token. Used by tenant invite + esign signing flows.';
COMMENT ON COLUMN users.tenant_invite_expires_at IS
  'S410/S377: NULL means no expiry check (pre-S410 row); NOT NULL enforced by accept route.';
COMMENT ON COLUMN users.landlord_invite_token IS
  'S410/S377: separate from email_verify_token. Used by admin landlord create + re-invite.';
COMMENT ON COLUMN users.landlord_invite_expires_at IS
  'S410/S377: NULL means no expiry check (pre-S410 row); NOT NULL enforced by accept route.';
COMMENT ON COLUMN users.email_verify_token_expires_at IS
  'S410/S377: 7-day expiry window on the email verification link.';
