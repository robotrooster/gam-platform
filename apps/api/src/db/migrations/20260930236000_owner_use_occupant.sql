-- S653 (Nic): "on the space for mobile home three that I marked as owner use,
-- there's no way to put an occupant name in there just for contact
-- information." An owner-use space has no lease and so no roster; this is who
-- is actually in it and how to reach them. Contact only — nothing is billed to
-- this person and they never get a portal from it.
ALTER TABLE units
  ADD COLUMN owner_occupant_name  text,
  ADD COLUMN owner_occupant_phone text,
  ADD COLUMN owner_occupant_email text;
COMMENT ON COLUMN units.owner_occupant_name IS 'S653: who lives in an owner-use space (contact only; read when status = owner_use).';
