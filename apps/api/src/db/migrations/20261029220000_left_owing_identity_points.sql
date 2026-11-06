-- Left-owing: the identity points that tell two people with the same name apart.
--
-- Nic, 10/29, on why identity capture exists at all:
--
--   "One other workflow that I'm thinking of that will help attach debt
--    correctly to people with the same name... a lot of parks will take a copy
--    of the driver's license."
--
-- A debt arrives from another operator as a name, maybe an email, maybe a
-- phone. All three move: people change numbers, share an address, remarry. A
-- state licence number does not, which makes it the one point that both
-- FINDS the person who changed everything else and PROVES the John Smith
-- standing at the counter is a different John Smith.
--
-- That second half is the more valuable one, and it needs the number stored on
-- the DEBT and not only on the GAM account, because an imported debt usually
-- has no account behind it.
--
-- No backfill: existing rows keep NULL and behave exactly as they do today —
-- an unknown identity point is never read as a contradiction.

ALTER TABLE tenant_left_owing
  ADD COLUMN IF NOT EXISTS id_number     text,
  ADD COLUMN IF NOT EXISTS id_state      text,
  ADD COLUMN IF NOT EXISTS date_of_birth date;

COMMENT ON COLUMN tenant_left_owing.id_number IS
  'Licence/state-ID number the ORIGINATING landlord had on file. Finds the person who changed email and phone; its disagreement proves a same-name is somebody else.';
COMMENT ON COLUMN tenant_left_owing.id_state IS
  'Issuing state for id_number. A number repeats across states, so the pair identifies; either side unknown is not a mismatch.';
COMMENT ON COLUMN tenant_left_owing.date_of_birth IS
  'Corroborates a name match and contradicts a wrong one. Never a match point on its own — a birthday is shared by thousands.';

CREATE INDEX IF NOT EXISTS idx_tenant_left_owing_id_number
  ON tenant_left_owing (upper(btrim(id_number)))
  WHERE settled_at IS NULL AND id_number IS NOT NULL;
