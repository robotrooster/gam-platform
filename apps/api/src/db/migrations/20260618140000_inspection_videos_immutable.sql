-- Walkthrough videos are IMMUTABLE evidence — no party may remove one
-- (Nic 2026-06-18). Append-only, consistent with the capture-everything
-- mandate. Enforced at the DB layer so even direct SQL / an admin cannot
-- destroy a video record:
--   1) the inspection_id FK becomes ON DELETE RESTRICT (was CASCADE) — you
--      cannot delete an inspection that has videos, so the cascade can never
--      wipe them.
--   2) a BEFORE DELETE trigger hard-blocks deleting a video row.
--   3) a BEFORE UPDATE trigger blocks repointing/clearing video_url (a
--      removal vector); other metadata (thumbnail, duration) stays editable.
--
-- Physical file immutability (WORM storage) is a storage-layer/dev-team
-- concern; this guarantees the DB record can never be removed.
-- No backfill needed.

ALTER TABLE unit_inspection_videos
  DROP CONSTRAINT unit_inspection_videos_inspection_id_fkey;
ALTER TABLE unit_inspection_videos
  ADD CONSTRAINT unit_inspection_videos_inspection_id_fkey
  FOREIGN KEY (inspection_id) REFERENCES unit_inspections(id) ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION unit_inspection_videos_no_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'unit_inspection_videos are immutable: a walkthrough video cannot be deleted';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_unit_inspection_videos_no_delete
  BEFORE DELETE ON unit_inspection_videos
  FOR EACH ROW EXECUTE FUNCTION unit_inspection_videos_no_delete();

CREATE OR REPLACE FUNCTION unit_inspection_videos_protect_url() RETURNS trigger AS $$
BEGIN
  IF NEW.video_url IS DISTINCT FROM OLD.video_url THEN
    RAISE EXCEPTION 'unit_inspection_videos.video_url is immutable and cannot be changed';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_unit_inspection_videos_protect_url
  BEFORE UPDATE ON unit_inspection_videos
  FOR EACH ROW EXECUTE FUNCTION unit_inspection_videos_protect_url();
