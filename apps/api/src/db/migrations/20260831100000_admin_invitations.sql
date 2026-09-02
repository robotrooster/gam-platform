-- S631 (Nic): "Let's make a way to invite other admins to admin portal."
--
-- Until now the only way to create an admin was a hand-written INSERT against
-- production — which is exactly how a co-owner membership got erased earlier
-- today with nobody able to say who did it. The most privileged role on the
-- platform was the one role with no invitation trail at all.
--
-- THE RULES THIS TABLE ENCODES
--
-- Only a super_admin can invite (route-enforced). An `admin` cannot mint more
-- admins, and cannot mint a super_admin — otherwise the distinction between the
-- two roles is decorative, since any admin could promote themselves by proxy.
--
-- A SHORT LIFE. Co-owner invites live 7 days; this one lives 3. An invitation to
-- the platform's operations console sitting in an abandoned inbox for a week is
-- a standing key, and the cost of re-sending is one click.
--
-- ONE ACCOUNT, ONE AUDIENCE. Accepting creates a NEW user. An email already on
-- the platform is refused rather than promoted: GAM's whole posture is that a
-- landlord sees landlord data and staff see the console (memory:
-- gam-audience-data-isolation), and Nic already runs this way himself —
-- nic@golddoor.io is super_admin, realestaterhoades@gmail.com is his landlord
-- account. Promoting a live landlord to admin would put one login on both sides
-- of every isolation rule the platform has.
--
-- No 2FA field here on purpose: MANDATORY_TOTP_ROLES already forces admin and
-- super_admin to enrol before requireAuth will honour their session, so an
-- invited admin hits that gate on first login whatever this table says.
CREATE TABLE IF NOT EXISTS admin_invitations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email              text NOT NULL,
  role               text NOT NULL CHECK (role IN ('admin', 'super_admin')),
  invited_by_user_id uuid NOT NULL REFERENCES users(id),
  token              text NOT NULL UNIQUE,
  status             text NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'accepted', 'revoked')),
  note               text,
  expires_at         timestamptz NOT NULL,
  accepted_at        timestamptz,
  accepted_user_id   uuid REFERENCES users(id),
  revoked_at         timestamptz,
  revoked_by_user_id uuid REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- One live invitation per address: re-inviting refreshes the token instead of
-- leaving two working keys out for the same person.
CREATE UNIQUE INDEX IF NOT EXISTS admin_invitations_one_pending
  ON admin_invitations (lower(email)) WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS admin_invitations_recent
  ON admin_invitations (created_at DESC);

COMMENT ON TABLE admin_invitations IS
  'S631: super_admin-issued invitations to the admin console. Accepting creates a NEW user in the invited role; an existing email is refused, never promoted.';
