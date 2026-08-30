-- S630 (Nic): a login that stays with the person, not with the property.
--
-- "I don't wanna sign in to my landlord account with the Oak Park email. We're
--  gonna be selling Oak Park and potentially giving up control of that email
--  address to the new buyer, and I need my sign in to be something that stays
--  with me."
--
-- There was no way to change a login email at all — no endpoint, no UI. Handing
-- the buyer that mailbox would have handed them password resets for the whole
-- landlord account, and with it every other property on it.
--
-- The new address is held PENDING until it is proven: the account keeps working
-- on the old email throughout, and the swap happens only when someone opens the
-- link sent to the new address. A change that is merely requested must never be
-- able to lock the owner out.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS pending_email            text,
  ADD COLUMN IF NOT EXISTS pending_email_token      text,
  ADD COLUMN IF NOT EXISTS pending_email_expires_at timestamptz;

-- The token is the credential that performs the swap, so it is looked up on its
-- own. Partial, because almost every row has none.
CREATE UNIQUE INDEX IF NOT EXISTS ux_users_pending_email_token
  ON users (pending_email_token) WHERE pending_email_token IS NOT NULL;

COMMENT ON COLUMN users.pending_email IS
  'A requested new login email, not yet in effect. Becomes users.email only when the link mailed to it is opened.';
