-- An explicitly CHOSEN landlord entity, replacing an implicit lookup that
-- breaks the moment anyone owns two.
--
-- S620 (Nic): "if I wanted to add another property that I am purchasing under
-- another entity, how would I do that? There's nowhere for that to happen."
--
-- WHY THIS COMES FIRST. Today a landlord's active entity is derived at login
-- from "the landlords row where this user is the owner" — a LEFT JOIN that
-- assumes ONE owned entity per person. Own two and it returns two rows and the
-- session picks one arbitrarily: every property added, every payout, every fee
-- could land on either. So "add another entity" is not a missing button, it is
-- a model that has no answer for the second one.
--
-- users.active_landlord_id makes the choice explicit and stable. Login prefers
-- it, falls back to the old behaviour when it is unset (every existing landlord
-- keeps exactly the entity they have today), and the switcher writes it.
--
-- NOT a foreign key with ON DELETE CASCADE: losing an entity must never delete
-- the user. SET NULL puts them back on the fallback path instead.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS active_landlord_id uuid
    REFERENCES landlords(id) ON DELETE SET NULL;

COMMENT ON COLUMN users.active_landlord_id IS
  'The landlord entity this user is currently operating in. NULL falls back to '
  'the entity they own (pre-S620 behaviour). Only ever set to an entity they '
  'are a member of — enforced in the route, since a FK cannot express it.';

CREATE INDEX IF NOT EXISTS users_active_landlord_idx
  ON users (active_landlord_id) WHERE active_landlord_id IS NOT NULL;
