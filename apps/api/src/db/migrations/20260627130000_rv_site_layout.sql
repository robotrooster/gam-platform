-- RV site layout (back-in vs pull-through) — Nic 2026-06-27.
--
-- WHY: RV sites differ by how a rig pulls in. A pull-through lets a driver go
-- straight through (no reversing — important for big rigs/trailers); a back-in
-- requires reversing. Guests/operators care which they get. This lets a
-- landlord tag each unit's layout, lets a reservation record a REQUIRED layout,
-- and lets the Master Schedule WARN (not block) staff when a move/edit would
-- put a reservation on a mismatched site.
--
-- Values mirror the shared RV_SITE_LAYOUTS enum exactly. 'none' = not an RV
-- site / no preference (the default — no backfill needed, existing rows are
-- correct as 'none').

ALTER TABLE units
  ADD COLUMN IF NOT EXISTS rv_site_layout text NOT NULL DEFAULT 'none';

ALTER TABLE units
  DROP CONSTRAINT IF EXISTS units_rv_site_layout_check;
ALTER TABLE units
  ADD CONSTRAINT units_rv_site_layout_check
  CHECK (rv_site_layout IN ('none', 'back_in', 'pull_through'));

ALTER TABLE unit_bookings
  ADD COLUMN IF NOT EXISTS required_site_layout text NOT NULL DEFAULT 'none';

ALTER TABLE unit_bookings
  DROP CONSTRAINT IF EXISTS unit_bookings_required_site_layout_check;
ALTER TABLE unit_bookings
  ADD CONSTRAINT unit_bookings_required_site_layout_check
  CHECK (required_site_layout IN ('none', 'back_in', 'pull_through'));
