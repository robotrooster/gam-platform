-- 10/31 — A CHALLENGE IS SPENT ONCE, AND THE SERVER IS THE ONE WHO SAYS SO.
--
-- WebAuthn's whole guarantee is that the authenticator signs a number the
-- server picked a moment ago. If the same number can be answered twice, a
-- captured response is a working sign-in, and the signature proves nothing it
-- was supposed to prove. So the challenge lives HERE, server-side, with a
-- consumed stamp — not in a cookie, not in a token handed to the client, and
-- not in the client's own storage where the person answering it could choose
-- what it says.
--
-- WHY NOT A SHORT-LIVED JWT, which is how the emailed-code step carries its
-- pending session: a signed token cannot be spent. The server would have no
-- record that this exact challenge had already been answered, and a replayed
-- response would verify perfectly against it until it expired. A sign-in
-- session is allowed to be used repeatedly; a nonce is not.
--
-- user_id IS NULL for a sign-in challenge, on purpose. "Face ID alone signs
-- you in" means GAM has not been told who is arriving — no email typed, no
-- password — so there is nobody to attach the challenge to until the response
-- comes back carrying a credential id. A registration challenge always names
-- the account that asked for it, because that person is already signed in.
--
-- Rows are kept after they are spent rather than deleted: a consumed row is
-- the evidence that says a second answer to the same challenge is a REPLAY
-- rather than a challenge nobody has heard of. The two refusals are different
-- facts and GAM keeps them apart.
--
-- They do not accumulate forever. A sign-in page issues one of these PER
-- VISIT — the browser's autofill offer asks for options before it can show a
-- key in the email field's list — so services/passkeys.ts drops rows more than
-- a week past their expiry each time it issues a new one. That is what the
-- expires_at index is for. A week keeps the replay answer useful without
-- letting a public page grow this table without bound.
--
-- No backfill: nobody has a passkey yet.

CREATE TABLE IF NOT EXISTS webauthn_challenges (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  challenge     text NOT NULL,
  purpose       text NOT NULL,
  -- NULL for a sign-in: see above.
  user_id       uuid REFERENCES users(id) ON DELETE CASCADE,
  rp_id         text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT NOW(),
  expires_at    timestamptz NOT NULL,
  consumed_at   timestamptz
);

ALTER TABLE webauthn_challenges DROP CONSTRAINT IF EXISTS webauthn_challenges_purpose_check;
ALTER TABLE webauthn_challenges
  ADD CONSTRAINT webauthn_challenges_purpose_check
  CHECK (purpose IN ('register', 'authenticate'));

-- A registration challenge belongs to the account that asked for it; a
-- sign-in challenge cannot, because nobody has said who they are yet.
ALTER TABLE webauthn_challenges DROP CONSTRAINT IF EXISTS webauthn_challenges_user_matches_purpose;
ALTER TABLE webauthn_challenges
  ADD CONSTRAINT webauthn_challenges_user_matches_purpose CHECK (
    (purpose = 'register'     AND user_id IS NOT NULL)
    OR (purpose = 'authenticate'));

-- The challenge itself is the lookup key coming back from the browser.
ALTER TABLE webauthn_challenges DROP CONSTRAINT IF EXISTS webauthn_challenges_challenge_key;
ALTER TABLE webauthn_challenges
  ADD CONSTRAINT webauthn_challenges_challenge_key UNIQUE (challenge);

CREATE INDEX IF NOT EXISTS ix_webauthn_challenges_expiry
  ON webauthn_challenges (expires_at);

COMMENT ON TABLE webauthn_challenges IS
  '10/31: one-use sign-in and registration nonces. Spent server-side so a captured WebAuthn response cannot be replayed; a consumed row is kept so a replay reads as a replay and not as an unknown challenge.';
COMMENT ON COLUMN webauthn_challenges.user_id IS
  'NULL for a sign-in challenge — "Face ID alone signs you in" means nobody has said who is arriving until the response names a credential.';
