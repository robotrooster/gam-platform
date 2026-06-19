-- Mark inspection photos that were taken with the in-app camera (live
-- capture) vs. uploaded from the gallery, so the landlord can trust a
-- photo is fresh (Nic 2026-06-18 — "must be taken with the camera not
-- uploaded so you know it's fresh"). Mirrors unit_inspection_videos.captured_live.
-- Default false: existing rows + any plain file upload are NOT marked live;
-- only the camera-capture path sets it true.
-- No backfill needed.
ALTER TABLE unit_inspection_photos
  ADD COLUMN captured_live boolean NOT NULL DEFAULT false;
