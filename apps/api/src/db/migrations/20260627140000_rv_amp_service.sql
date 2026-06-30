-- RV electrical service (30 / 50 / both amp) — Nic 2026-06-27.
--
-- WHY: RV pedestals provide 30-amp service, 50-amp service, or both at once. A
-- rig needs a specific amperage; a 50-amp rig can't draw from a 30-amp-only
-- pedestal (and vice versa). Owner tags each unit's service; a reservation can
-- record a REQUIRED amperage; the Master Schedule WARNS (not blocks) staff when
-- a move/edit would put a reservation on an incompatible site. Companion to the
-- rv_site_layout field (20260627130000).
--
-- Values mirror the shared RV_AMP_SERVICES enum exactly. 'none' = not an RV site
-- / unspecified (the default — no backfill needed). 'both' on a UNIT satisfies a
-- 30- or 50-amp reservation.

ALTER TABLE units
  ADD COLUMN IF NOT EXISTS rv_amp_service text NOT NULL DEFAULT 'none';

ALTER TABLE units
  DROP CONSTRAINT IF EXISTS units_rv_amp_service_check;
ALTER TABLE units
  ADD CONSTRAINT units_rv_amp_service_check
  CHECK (rv_amp_service IN ('none', '30', '50', 'both'));

ALTER TABLE unit_bookings
  ADD COLUMN IF NOT EXISTS required_amp_service text NOT NULL DEFAULT 'none';

ALTER TABLE unit_bookings
  DROP CONSTRAINT IF EXISTS unit_bookings_required_amp_service_check;
ALTER TABLE unit_bookings
  ADD CONSTRAINT unit_bookings_required_amp_service_check
  CHECK (required_amp_service IN ('none', '30', '50', 'both'));
