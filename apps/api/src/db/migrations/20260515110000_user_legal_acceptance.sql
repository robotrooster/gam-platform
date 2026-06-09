-- Legal acceptance timestamps for Terms of Service + Privacy Policy.
--
-- Captures who accepted what, when. Required evidence if enforcement
-- of the terms is later challenged: a User claiming they never agreed
-- to arbitration / class action waiver / liability cap needs to be
-- countered with a timestamped acceptance record matched to their
-- registration session.
--
-- The signup acceptance gate (S29X frontend) sets accepted_terms: true
-- in the register POST body; the backend stamps both columns to NOW()
-- on successful INSERT. The frontend cannot submit without both
-- acceptances; the backend refuses requests where the flag is false.
--
-- No backfill — pre-S29X users keep NULL on both columns. The
-- distinction (NULL vs timestamp) is itself meaningful: it tells us
-- which Users registered before the gate was wired vs after. For
-- launch we may want a re-acceptance prompt at next login for users
-- with NULL on either column, but that's a separate session.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS accepted_tos_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS accepted_privacy_at timestamptz NULL;

COMMENT ON COLUMN users.accepted_tos_at IS
  'Timestamp when this user accepted the Terms of Service at registration. NULL = pre-acceptance-gate user; not yet re-prompted.';

COMMENT ON COLUMN users.accepted_privacy_at IS
  'Timestamp when this user accepted the Privacy Policy at registration. NULL = pre-acceptance-gate user; not yet re-prompted.';
