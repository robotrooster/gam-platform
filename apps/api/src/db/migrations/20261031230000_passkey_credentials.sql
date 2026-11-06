-- 10/30 (Nic) — A PASSKEY REPLACES THE EMAILED CODE.
--
--   "A passkey replaces the emailed code; password + code stays the fallback."
--
-- He could not sign in on his phone. His password lives in Safari's keychain
-- and Chrome on iOS keeps a separate vault, so nothing autofilled; and the
-- emailed code then sends him out of the browser to the mail app, the trip
-- S639 already had to rescue by making the pending code step survive a reload.
-- Face ID is already two factors — the device and the biometric — so asking
-- for the emailed code on top keeps exactly the friction the feature exists to
-- remove. Password + emailed code stays for anybody without a passkey, so
-- nothing about that path changes.
--
-- One row per registered device, per person. What each column is for:
--
--   credential_id  the authenticator's own id for this key, base64url. Unique
--                  platform-wide, because it is the handle a sign-in arrives
--                  with BEFORE anybody has been identified — this is the
--                  lookup that says who is signing in.
--   public_key     the COSE public key, raw bytes. GAM never holds a private
--                  key; there is nothing in this table to steal and sign with.
--   sign_count     the authenticator's own use counter. A response that does
--                  not advance it is a replay or a cloned key, and is refused.
--                  Apple's passkeys always report 0, which the spec answers by
--                  skipping the comparison when both sides are 0 — so a key
--                  that never counts is not locked out by its own honesty.
--   transports     how the browser said this key can be reached (internal,
--                  hybrid, usb). Handed back at sign-in so the phone prompts
--                  the right way instead of offering a USB key to somebody
--                  holding a Face ID iPhone.
--   device_name    what the person calls it ("Nic's iPhone"). The settings
--                  list has to be removable by a human who recognises the row;
--                  a base64url credential id is not that.
--   backed_up      whether the key is synced to a keychain. A device-bound key
--                  dies with the phone and a synced one survives it, which is
--                  the whole of the answer to "can I still get in".
--   last_used_at   so a person pruning old devices can see which key is the
--                  one they are holding.
--
-- Deleting the account deletes its keys. A passkey is not a record of money or
-- of a decision (memory gam-data-retention-keep-everything) — it is a door
-- key, and a key to a door that no longer exists is not worth keeping.
--
-- No backfill: nobody has a passkey yet.

CREATE TABLE IF NOT EXISTS user_passkeys (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id   text NOT NULL,
  public_key      bytea NOT NULL,
  sign_count      bigint NOT NULL DEFAULT 0,
  transports      text[],
  device_name     text NOT NULL,
  backed_up       boolean NOT NULL DEFAULT FALSE,
  -- The relying-party id the key was made against ('localhost' in dev, the
  -- apex in production). A key is only valid for its own domain, so a database
  -- restored from one environment into another must not offer keys that can
  -- never answer.
  rp_id           text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT NOW(),
  last_used_at    timestamptz
);

-- One credential id, one row, platform-wide: this is the pre-identity lookup.
ALTER TABLE user_passkeys DROP CONSTRAINT IF EXISTS user_passkeys_credential_id_key;
ALTER TABLE user_passkeys
  ADD CONSTRAINT user_passkeys_credential_id_key UNIQUE (credential_id);

-- A counter only ever goes up (see above on the honest zero).
ALTER TABLE user_passkeys DROP CONSTRAINT IF EXISTS user_passkeys_sign_count_sane;
ALTER TABLE user_passkeys
  ADD CONSTRAINT user_passkeys_sign_count_sane CHECK (sign_count >= 0);

-- A device the person can recognise is the point of the name — an empty one
-- would leave them guessing which row to remove.
ALTER TABLE user_passkeys DROP CONSTRAINT IF EXISTS user_passkeys_device_name_present;
ALTER TABLE user_passkeys
  ADD CONSTRAINT user_passkeys_device_name_present CHECK (length(btrim(device_name)) > 0);

CREATE INDEX IF NOT EXISTS ix_user_passkeys_user
  ON user_passkeys (user_id, created_at DESC);

COMMENT ON TABLE user_passkeys IS
  '10/30 (Nic): "a passkey replaces the emailed code; password + code stays the fallback." One registered device per row. Public keys only — GAM never holds a private key.';
COMMENT ON COLUMN user_passkeys.sign_count IS
  'The authenticator''s own use counter. A response that does not advance it is a replay or a clone and is refused; a key that always reports 0 (Apple) is exempt by the spec, not by us.';
COMMENT ON COLUMN user_passkeys.backed_up IS
  'Synced to a keychain (survives losing the phone) or device-bound (does not). The answer to "can I still get in".';
