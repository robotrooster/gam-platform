-- S571 (Nic) — evidence must be captured LIVE, not uploaded from an album.
-- All GAM photo/video evidence is taken fresh through the camera (getUserMedia),
-- same as inspection photos (unit_inspection_photos.captured_live). Record the
-- provenance flag on the two S571 evidence tables so the UI can badge it "live"
-- and we never treat a gallery upload as live capture.
-- Default TRUE: these tables were created THIS session and only ever receive
-- camera captures, so existing rows (test data) are live by construction.
ALTER TABLE maintenance_media
  ADD COLUMN IF NOT EXISTS captured_live boolean NOT NULL DEFAULT true;

ALTER TABLE tenant_walkthrough_media
  ADD COLUMN IF NOT EXISTS captured_live boolean NOT NULL DEFAULT true;
