-- S631 (Nic, DIRECTIVE): "It's a shared workflow process. Say I read some of the
-- meters and I have somebody else read some of the meters — they need to be able
-- to input the ones that they read that aren't finished and have it all saved so
-- that it can be broken up in batches between users. I have the master bills for
-- the water, but he still has to read the submeters for the spots that have the
-- submeters. Same utility. So splitting it by electric and water doesn't work.
-- It needs a better flow that would cover any situation."
--
-- He is right and this supersedes the utility-scoped runs from earlier today.
-- Utility was the wrong axis: his own split runs DOWN THE MIDDLE of one utility
-- — the water masters arrive in his post, the water submeters are read on the
-- ground by somebody else. No fixed carve-up of the meter list survives contact
-- with how the work is actually divided.
--
-- What DOES generalise is assigning meters to people. "Blu reads the submeters,
-- I do the masters" is a standing arrangement, not a monthly decision, so it
-- belongs on the meter. Any division works: by utility, by submeter-vs-master,
-- by section of the park, or none at all.
--
-- Deliberately NOT a lock. An assignment says who is EXPECTED to read a meter,
-- never who is permitted to — whoever is standing in front of it can enter it.
-- A reading is a fact about a dial, and a park where the wrong person cannot
-- type in a number they are looking at is a park where the month does not close.
ALTER TABLE utility_meters
  ADD COLUMN IF NOT EXISTS default_reader_user_id uuid REFERENCES users(id) ON DELETE SET NULL;

COMMENT ON COLUMN utility_meters.default_reader_user_id IS
  'S631: who is expected to read this meter. Guidance for dividing the monthly walk between people — never a permission check; anyone with utility.read_meters can enter any meter.';

CREATE INDEX IF NOT EXISTS utility_meters_by_reader
  ON utility_meters (default_reader_user_id) WHERE default_reader_user_id IS NOT NULL;
