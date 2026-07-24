-- S553/S554: multi-owner landlord entities (Oak Park: 3 owners; owners
-- also hold separate portfolios).
--
-- Model (Nic-locked): every landlords row IS the entity — a person or an
-- LLC (business_name/ein already live there; entity identity is
-- independent of member count — single-member LLCs exist). This table
-- makes membership many-to-many: a user can be an owner-member of any
-- number of entities, and an entity can have any number of owner-members.
-- landlords.user_id remains the FOUNDING member (kept for compatibility;
-- every access path should consult membership, which the backfill seeds).
--
-- Access flow: memberships are resolved at LOGIN into the JWT
-- (landlordIds[]), so the synchronous scope checks (middleware/scope.ts)
-- stay synchronous. Membership changes take effect at next login.
-- Portfolio surfaces aggregate across the set — NO entity switcher (Nic).
-- Money (payouts, Connect account, bank) stays strictly per-entity.
--
-- Backfill: one 'owner' row per existing landlords row for its user_id,
-- so existing accounts behave identically.

CREATE TABLE landlord_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  landlord_id uuid NOT NULL REFERENCES landlords(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'owner' CHECK (role IN ('owner')),
  added_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (landlord_id, user_id)
);

CREATE INDEX landlord_members_user_idx ON landlord_members (user_id);

INSERT INTO landlord_members (landlord_id, user_id, role)
SELECT id, user_id, 'owner' FROM landlords
ON CONFLICT (landlord_id, user_id) DO NOTHING;
