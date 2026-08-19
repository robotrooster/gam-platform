-- S605 (Nic): a property sale needs every owner's consent.
--
-- "Anybody that has a GAM platform account as an owner or a landlord on a
-- partnership needs to all have a signing or confirmation... so that one person
-- can't just accidentally sell or transfer account ownership out from underneath
-- other people."
--
-- Transferring a property was a single authenticated call. In a three-member
-- partnership that let any one owner hand the asset to someone else — by mistake
-- or otherwise — with no trace until the others noticed their property was gone.
-- That is the highest-consequence action in the product and it had the lowest
-- bar.
--
-- Two-phase now: a request is RAISED, every owner-member of the selling entity
-- CONFIRMS with a code sent to their email, and only a fully-approved request
-- executes. The initiator confirms too — Nic asked for that explicitly, and an
-- accidental click by the person who raised it is exactly the failure mode.
--
-- Passive owners without a GAM account are out of scope by definition: the
-- platform can only ask people it knows about. This gates on landlord_members,
-- which is precisely "owners with an account".
--
-- Requests EXPIRE. A half-approved sale left open for months is a landmine — the
-- remaining owner clicks approve a year later and a property moves.

CREATE TABLE IF NOT EXISTS property_transfer_requests (
  id                 uuid PRIMARY KEY DEFAULT public.gen_random_uuid(),
  property_id        uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  from_landlord_id   uuid NOT NULL REFERENCES landlords(id) ON DELETE CASCADE,
  to_landlord_id     uuid NOT NULL REFERENCES landlords(id) ON DELETE CASCADE,
  initiated_by       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status             text NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','executed','cancelled','expired')),
  note               text,
  expires_at         timestamptz NOT NULL,
  executed_at        timestamptz,
  transfer_id        uuid REFERENCES property_transfers(id) ON DELETE SET NULL,
  cancelled_at       timestamptz,
  cancelled_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- One live request per property: two open sales of the same asset is never a
-- real intention, and it makes "who approved what" unanswerable.
CREATE UNIQUE INDEX IF NOT EXISTS idx_transfer_request_one_pending
  ON property_transfer_requests (property_id) WHERE status = 'pending';

-- One row per owner who must consent, created when the request is raised so the
-- set of required approvers is FROZEN at that moment. Adding an owner mid-flight
-- must not silently change what a sale needs, and removing one must not let a
-- sale through on fewer signatures than it started with.
CREATE TABLE IF NOT EXISTS property_transfer_approvals (
  id             uuid PRIMARY KEY DEFAULT public.gen_random_uuid(),
  request_id     uuid NOT NULL REFERENCES property_transfer_requests(id) ON DELETE CASCADE,
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Emailed to this owner; entering it is the confirmation. Not a link: a link
  -- in a forwarded email is a signature anyone can apply.
  code           text NOT NULL,
  approved_at    timestamptz,
  declined_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (request_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_transfer_approvals_open
  ON property_transfer_approvals (request_id) WHERE approved_at IS NULL AND declined_at IS NULL;

COMMENT ON TABLE property_transfer_requests IS
  'S605: a proposed property sale awaiting consent from every owner-member of the selling entity. Only a fully-approved request executes.';
COMMENT ON TABLE property_transfer_approvals IS
  'S605: one per owner who must confirm a sale. The required set is frozen when the request is raised. A single decline kills it.';
