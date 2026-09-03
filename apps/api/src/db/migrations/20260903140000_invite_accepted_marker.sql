-- S637 (Nic): "Several more people tell me that their invite expired when they
-- already accepted it. They tried to go back to that email only to find out
-- that it's expired because they used it, and they think that it locked them
-- out, and they need a new invite."
--
-- Activation cleared tenant_invite_token, so a tenant returning to their own
-- invite email was indistinguishable from someone holding a bad or genuinely
-- expired link — and both got "Invalid or expired invite link". For somebody
-- who had already set their password successfully, that message is simply
-- wrong, and it reads as being locked out of an account they just created.
--
-- Keeping the token lets us recognise the person. It stops being a credential
-- the moment this column is set: the activation route refuses any token whose
-- row is already accepted, so a forwarded link grants nothing. What it buys is
-- the ability to say "you have already done this, sign in" instead of implying
-- they need a whole new invite.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS tenant_invite_accepted_at timestamptz;

COMMENT ON COLUMN users.tenant_invite_accepted_at IS
  'S637: when a tenant invite was activated. Set = the token is spent and authorises nothing; it is kept only so a returning tenant can be told they are already set up rather than "expired".';

CREATE INDEX IF NOT EXISTS idx_users_tenant_invite_token
  ON users (tenant_invite_token) WHERE tenant_invite_token IS NOT NULL;
