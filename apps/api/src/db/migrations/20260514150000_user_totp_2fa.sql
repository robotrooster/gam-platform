-- S288: TOTP-based two-factor authentication.
--
-- Why now: GAM moves money. Admin / admin_ops / landlord / PM-company
-- accounts can configure bank routing, trigger transfers, and (in the
-- landlord case) accept rent on behalf of multiple tenants. A
-- credential-stuffing or SIM-swap attack against any of those roles
-- has direct financial impact. 2FA blocks the common attack class.
--
-- Library: otplib (RFC-6238 standard TOTP — works with any
-- authenticator app — Google Authenticator, Authy, 1Password, etc.).
-- SMS deliberately excluded — SIM-swap attacks against financial
-- accounts are a real threat model and an SMS second factor doesn't
-- raise attacker cost enough to be worth the operational overhead.
--
-- Mandatory vs optional posture lives in code (auth.ts), keyed off
-- user.role: admin / super_admin / admin_ops are mandatory at launch;
-- landlord / pm-company are optional-with-prompts; tenant is fully
-- optional. The schema is the same for all paths — the difference is
-- whether the post-login response sets `must_enroll_totp: true`.
--
-- Schema additions:
--
--   users.totp_enabled        boolean NOT NULL DEFAULT FALSE
--     Set TRUE on /enroll-confirm after a successful first-token
--     verification. Cleared on /disable. Login refuses to issue a
--     full JWT when this is TRUE until /totp/verify completes.
--
--   users.totp_secret         text NULL
--     Base32-encoded shared secret between the server and the
--     authenticator app. Generated at /enroll-start (random 20 bytes
--     via otplib's authenticator.generateSecret). Stored as-is (not
--     hashed — pino's `err` serializer issue aside, the server needs
--     the plaintext to compute the current token for verification).
--     The secret never leaves the server; the authenticator gets it
--     once via the otpauth:// URL embedded in the QR code.
--
--   users.totp_enrolled_at    timestamptz NULL
--     Audit timestamp — when did this user first complete enrollment.
--     Cleared on disable.
--
-- Recovery codes live in a separate table so we can track per-code
-- used_at without storing all codes inline. 10 codes per user at
-- enrollment; each is single-use; bcrypt-hashed at rest (same
-- treatment as password_reset_tokens).

ALTER TABLE public.users
  ADD COLUMN totp_enabled       boolean NOT NULL DEFAULT FALSE,
  ADD COLUMN totp_secret        text,
  ADD COLUMN totp_enrolled_at   timestamp with time zone;

CREATE TABLE public.user_totp_recovery_codes (
  id          uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  user_id     uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  code_hash   text NOT NULL,
  used_at     timestamp with time zone,
  created_at  timestamp with time zone NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_user_totp_recovery_codes_user_id
  ON public.user_totp_recovery_codes (user_id)
  WHERE used_at IS NULL;
