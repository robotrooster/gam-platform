-- Per-inspection walkthrough videos — GAM's in-house "mini-YouTube" for the
-- unit lifecycle (move-in / move-out / turnover clean+repair). Videos live in
-- GAM's own storage, never a third party (in-house-only principle; tenant
-- video stays on GAM servers). Visibility is landlord/internal for now — the
-- tenant-facing lifecycle view is deferred. One inspection may have several
-- videos. The per-unit lifecycle is these rows joined through unit_inspections
-- by unit_id, ordered by time.
--
-- No backfill needed — new table.
CREATE TABLE unit_inspection_videos (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  inspection_id uuid NOT NULL REFERENCES unit_inspections(id) ON DELETE CASCADE,
  title text,
  video_url text NOT NULL,
  thumbnail_url text,
  duration_seconds integer,
  file_size bigint,
  mime_type text,
  captured_live boolean DEFAULT false NOT NULL,
  uploaded_by uuid NOT NULL,
  uploaded_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT unit_inspection_videos_pkey PRIMARY KEY (id)
);

CREATE INDEX idx_unit_inspection_videos_inspection ON unit_inspection_videos (inspection_id);
