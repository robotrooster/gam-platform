-- S565: email-code 2FA as an alternative second factor to authenticator TOTP.
--
-- Admin/super_admin logins are mandatory-2FA (MANDATORY_TOTP_ROLES). Until now
-- the only second factor was an authenticator app (TOTP). This adds an
-- EMAIL-CODE option: on login, a 6-digit code is emailed to the user, entered on
-- a second step, exchanged for the full session. The factor is control of the
-- inbox — no shared secret to store, no QR to scan.
--
-- Precedence at login (see routes/auth.ts): totp_enabled wins (authenticator);
-- else email_2fa_enabled → email code; else a mandatory-2FA role still must
-- enroll TOTP. So enabling email_2fa satisfies the mandatory-2FA requirement.
--
-- No backfill: both columns default to the current behavior (email_2fa off).

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS email_2fa_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN users.email_2fa_enabled IS
  'S565: when true (and totp_enabled false), login requires a 6-digit code emailed to the user. Satisfies the mandatory-2FA requirement for admin/super_admin without an authenticator app.';

-- Short-lived login codes. One active (unconsumed, unexpired) code per user is
-- the norm; a resend supersedes the prior code. bcrypt-hashed — never store the
-- plaintext. attempts caps brute force (handler invalidates at the cap).
CREATE TABLE login_email_otps (
  id           uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash    text NOT NULL,
  purpose      text NOT NULL DEFAULT 'login_2fa',
  expires_at   timestamp with time zone NOT NULL,
  consumed_at  timestamp with time zone,
  attempts     integer NOT NULL DEFAULT 0,
  created_at   timestamp with time zone NOT NULL DEFAULT NOW(),
  CONSTRAINT leo_purpose_check CHECK (purpose IN ('login_2fa'))
);

CREATE INDEX idx_login_email_otps_user_active
  ON login_email_otps (user_id, created_at DESC)
  WHERE consumed_at IS NULL;

COMMENT ON TABLE login_email_otps IS
  'S565: short-lived, bcrypt-hashed email 2FA login codes. One active code per user; resend supersedes. attempts caps brute force.';
