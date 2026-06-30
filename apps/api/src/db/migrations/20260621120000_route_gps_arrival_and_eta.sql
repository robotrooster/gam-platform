-- Route GPS-arrival + downstream ETA (service-business, S510).
--
-- WHY: stops should auto-complete on REAL arrival, not a drive-time
-- guess. The driver device registers arrival by GPS geofence; the stop
-- then completes after a short dwell. Both knobs are business-owner
-- configurable. The driver's live position also lets us project an ETA
-- for each downstream stop so customers get "arriving ~2:45".
--
-- stop_dwell_seconds: seconds to wait after GPS arrival before a stop
--   auto-completes (default 60 — Nic's "one minute per stop").
-- arrival_geofence_meters: how close (meters) counts as "arrived".
-- route_stops.projected_eta: live ETA for a not-yet-finalized stop,
--   recomputed from the driver's current position. Nullable; no
--   backfill needed (populated as positions stream in).
-- generated_routes.last_{lat,lon,position_at}: driver's last reported
--   GPS fix, the basis for ETA recompute. Nullable; no backfill needed.

ALTER TABLE businesses
  ADD COLUMN stop_dwell_seconds integer NOT NULL DEFAULT 60,
  ADD COLUMN arrival_geofence_meters integer NOT NULL DEFAULT 150;

ALTER TABLE route_stops
  ADD COLUMN projected_eta timestamp with time zone;

ALTER TABLE generated_routes
  ADD COLUMN last_lat numeric(9,6),
  ADD COLUMN last_lon numeric(9,6),
  ADD COLUMN last_position_at timestamp with time zone;
