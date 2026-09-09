-- S639 (Nic): "you still have it listed as eight people not invited yet. But
-- then the buttons all say cancel invites... We have literally sent invites to
-- every single person. You did it or I did it. I typed in every single email.
-- Email invites are sent. So what the hell's wrong with this pool?"
--
-- He is right, and the cause is a gap left by S637 six days ago.
--
-- The pending pool derived its three states from ONE column, users.tenant_invite_token:
--   accepted  ← tenant_invite_accepted_at IS NOT NULL
--   invited   ← tenant_invite_token IS NOT NULL
--   not_invited ← neither
--
-- Before S637, activating an invite CLEARED the token. S637 changed that (it
-- keeps the token and stamps tenant_invite_accepted_at instead) so a returning
-- tenant could be told "you already did this" rather than "expired". But the new
-- column was never backfilled for anyone who had activated BEFORE Sept 3. Their
-- token was already gone and their accepted_at was null, so they fell through to
-- the last branch — and the pool told Nic that people who were logging in and
-- using the portal every day had never been invited at all.
--
-- Seven of them at Mountain View alone. Five had confirmed logins. Two (Calvin
-- Curtis, Dakota Lane) genuinely had no invite email, and that real signal was
-- buried in five false ones — which is exactly how a status column stops being
-- useful.
--
-- Two fixes, so this cannot recur:
--
-- 1. tenant_invite_sent_at records that a token was EVER issued, stamped by a
--    trigger rather than at the seven separate call sites that issue one (the
--    units-wide rule: enforce it in the database, do not audit call sites). A
--    consumed or cleared token can no longer erase the fact that we wrote to
--    somebody. "Not invited yet" now means nothing was ever sent, which is what
--    the words say and what Nic reads them to mean.
--
-- 2. Backfill both columns from the evidence we still hold.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS tenant_invite_sent_at timestamptz;

COMMENT ON COLUMN users.tenant_invite_sent_at IS
  'S639: when a tenant invite token was first issued to this user. Survives the token being consumed or cleared, so the pending pool can tell "we have written to them" from "we never have".';

CREATE OR REPLACE FUNCTION stamp_tenant_invite_sent() RETURNS trigger AS $$
BEGIN
  -- Only on the transition to a live token, and only the FIRST one: this is
  -- "have we ever written to them", not "when was the most recent resend".
  IF NEW.tenant_invite_token IS NOT NULL
     AND (TG_OP = 'INSERT' OR OLD.tenant_invite_token IS DISTINCT FROM NEW.tenant_invite_token)
     AND NEW.tenant_invite_sent_at IS NULL THEN
    NEW.tenant_invite_sent_at := NOW();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_stamp_tenant_invite_sent ON users;
CREATE TRIGGER trg_stamp_tenant_invite_sent
  BEFORE INSERT OR UPDATE OF tenant_invite_token ON users
  FOR EACH ROW EXECUTE FUNCTION stamp_tenant_invite_sent();

-- ── Backfill 1: people who still hold a live token ──────────────────────────
UPDATE users
   SET tenant_invite_sent_at = COALESCE(tenant_invite_sent_at, created_at)
 WHERE tenant_invite_token IS NOT NULL
   AND tenant_invite_sent_at IS NULL;

-- ── Backfill 2: an invite email we can still see in the send log ────────────
-- The log is the record of what actually left the building. tenant_invite is
-- not a permanent category, so this is done NOW while the rows are all present.
UPDATE users u
   SET tenant_invite_sent_at = e.first_sent
  FROM (SELECT lower(to_email) AS email, MIN(created_at) AS first_sent
          FROM email_send_log
         WHERE category LIKE 'tenant_invite%' OR category = 'tenant_onboarded'
         GROUP BY 1) e
 WHERE lower(u.email) = e.email
   AND u.tenant_invite_sent_at IS NULL;

-- ── Backfill 3: pre-S637 activations ────────────────────────────────────────
-- Somebody who has logged in has, beyond argument, accepted their invite. That
-- is the strongest evidence available and the only one used here: a password
-- alone is not enough, because a password reset also sets one.
UPDATE users
   SET tenant_invite_accepted_at = last_login_at,
       tenant_invite_sent_at     = COALESCE(tenant_invite_sent_at, created_at)
 WHERE role = 'tenant'
   AND tenant_invite_accepted_at IS NULL
   AND last_login_at IS NOT NULL
   AND password_hash IS NOT NULL;
