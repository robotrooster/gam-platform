-- 10/20 — A MOVE-OUT READ THE LANDLORD HAS TO LOOK AT BEFORE IT BILLS.
--
-- The monthly reading run has held an implausible read for the landlord since
-- S533: usage over the utility type's threshold flags, bills nothing, and waits
-- for a human. The MOVE-OUT read never got that guard, and the move-out read is
-- the one place it cannot be missing: it bills, invoices and emails the
-- departing tenant in the same breath. One extra zero typed at the counter
-- (120000 for 12000 on a six-digit face) is 108,000 kWh, a $12,960 charge in a
-- departing tenant's inbox pointed at their deposit — and the desk is shown only
-- "Read recorded — final bill created", never the figure.
--
-- Holding such a read means its bill is built LATER, by the landlord's
-- double-check. By then the two things the original call knew are gone: WHOSE
-- move-out the read closes out (the to-do names the leaving household so the
-- bill cannot land on one that left earlier), and whether it was a space move —
-- a resident who is staying with us and must never receive a "your final utility
-- bill is ready" email. So the held read carries both forward.
--
-- Written only when a read is held. No backfill needed: nothing is held yet, and
-- a read with these columns NULL/false behaves exactly as every read does today.
ALTER TABLE utility_meter_readings
  ADD COLUMN IF NOT EXISTS move_out_lease_id uuid REFERENCES leases(id),
  ADD COLUMN IF NOT EXISTS move_out_space_move boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN utility_meter_readings.move_out_lease_id IS
  'The household a HELD move-out read closes out, stamped when the read is held for the landlord''s double-check so resolving it bills the same household the desk named.';
COMMENT ON COLUMN utility_meter_readings.move_out_space_move IS
  'TRUE when a HELD move-out read is a space move''s closing read: the resident is staying, so resolving it bills their old space with no final invoice and no "your last days" email.';
