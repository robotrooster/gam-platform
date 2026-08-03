-- S571 (Nic) — tenant-owned maintenance evidence media.
-- A tenant must be able to attach their OWN photos/video to a specific
-- maintenance request — e.g. documenting that a "completed" fix wasn't actually
-- done ("this still leaks, I had to call them back out"). This is an
-- authenticity/evidence record: the LANDLORD CANNOT DELETE tenant-uploaded
-- media (there is no delete path at all — same immutable posture as the
-- maintenance request itself; see memory keep-everything / soft-delete).
-- The maintenance worker/landlord can also upload their own photos of the fix
-- through the same table, so both sides' records live together, attributed.
CREATE TABLE IF NOT EXISTS maintenance_media (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id          uuid NOT NULL REFERENCES maintenance_requests(id) ON DELETE CASCADE,
  uploaded_by_user_id uuid NOT NULL REFERENCES users(id),
  uploader_role       text NOT NULL,   -- 'tenant' | 'landlord' | 'maintenance' | ...
  media_type          text NOT NULL CHECK (media_type IN ('photo','video')),
  file_url            text NOT NULL,   -- authed serve route, never a public path
  caption             text,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_maintenance_media_request ON maintenance_media(request_id);
