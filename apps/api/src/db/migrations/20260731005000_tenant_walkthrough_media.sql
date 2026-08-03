-- S571 (Nic) — standalone tenant walkthroughs.
-- A tenant needs to document their unit on their OWN initiative — not only
-- reactively on a maintenance request or during a landlord inspection. This
-- backs the "My Walkthroughs" page's manual "start a new walkthrough" flow:
-- the tenant uploads photos/video of their unit whenever they want (move-in
-- condition, a running record, proof around a repair). Same immutable posture
-- as the other evidence media: there is NO delete path — the landlord can view
-- it but cannot erase the tenant's record.
CREATE TABLE IF NOT EXISTS tenant_walkthrough_media (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  unit_id             uuid REFERENCES units(id),   -- resolved from active lease at upload
  uploaded_by_user_id uuid NOT NULL REFERENCES users(id),
  media_type          text NOT NULL CHECK (media_type IN ('photo','video')),
  file_url            text NOT NULL,               -- authed serve route, never public
  caption             text,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tenant_walkthrough_media_tenant ON tenant_walkthrough_media(tenant_id);
CREATE INDEX IF NOT EXISTS idx_tenant_walkthrough_media_unit ON tenant_walkthrough_media(unit_id);
