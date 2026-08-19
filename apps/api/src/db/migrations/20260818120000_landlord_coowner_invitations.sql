-- S605 (Nic): invite a co-owner by link instead of demanding they pre-register.
--
-- Adding a partner to an entity required them to ALREADY hold a landlord
-- account — POST /landlords/members refuses an unknown email with "have them
-- register as a landlord first, then add them." Nic: "it seems like kind of a
-- backwards flow. I should be able to invite him through a link, and then he
-- can add more property if he has it."
--
-- It is backwards for the common case: a three-member partnership where the
-- other members have no GAM presence yet and no property of their own. Asking
-- them to guess their way through a signup, unprompted, before their partner
-- can grant them anything is how an invite dies.
--
-- Mirrors pm_invitations deliberately (token, expiry, accepted/revoked stamps)
-- so the two invitation flows behave the same and can be reasoned about
-- together.
--
-- SEPARATION IS THE POINT AND IT SURVIVES THIS. Accepting an invite still gives
-- the invitee their OWN landlord entity — the membership is added ALONGSIDE it,
-- never instead of it. Properties they create later attach to their own entity
-- (property creation resolves landlord_id from their primary profile), so a
-- partner's unrelated portfolio never lands in the inviter's books. Nic: "I
-- don't necessarily need to be part of his other operation."
--
-- No backfill: existing co-owners were added directly and have their
-- landlord_members rows already.

CREATE TABLE IF NOT EXISTS landlord_member_invitations (
  id                 uuid PRIMARY KEY DEFAULT public.gen_random_uuid(),
  landlord_id        uuid NOT NULL REFERENCES landlords(id) ON DELETE CASCADE,
  email              text NOT NULL,
  invited_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status             text NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','accepted','revoked','expired')),
  token              text NOT NULL UNIQUE,
  expires_at         timestamptz NOT NULL,
  accepted_at        timestamptz,
  accepted_user_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  revoked_at         timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- One live invite per email per entity: re-inviting should refresh the existing
-- one rather than leave several valid tokens outstanding for the same person.
CREATE UNIQUE INDEX IF NOT EXISTS idx_landlord_member_inv_pending
  ON landlord_member_invitations (landlord_id, lower(email))
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_landlord_member_inv_token
  ON landlord_member_invitations (token) WHERE status = 'pending';

COMMENT ON TABLE landlord_member_invitations IS
  'S605: co-owner invites for a landlord entity. Accepting adds a landlord_members row ALONGSIDE the invitee''s own entity — it never merges portfolios.';
