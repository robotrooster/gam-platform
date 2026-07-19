-- S547: snowbird site lock (Nic).
--
-- Guests who get the same site every year can be LOCKED to it by the
-- landlord. A locked reservation is exempt from every automatic mover:
-- the nightly schedule compressor, W-20 relocation of blocking bookings,
-- and the extend-and-relocate fallback. Staff can still move it manually
-- (unlock first, or an explicit unit swap clears the lock decision).
--
-- No backfill needed (default FALSE = current movable behavior).

ALTER TABLE unit_bookings
  ADD COLUMN locked_to_unit boolean NOT NULL DEFAULT FALSE;
