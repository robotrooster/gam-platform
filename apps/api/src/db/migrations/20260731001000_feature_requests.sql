-- S571 — Feature-request capture.
-- The tenant "Have a feature idea? → Submit Request" button previously deep-
-- linked to a non-existent admin /feature-requests page with NO backend, so
-- ideas went nowhere. This table captures them for real. Any authenticated
-- user (tenant, landlord, POS operator) can submit; the GAM team (super_admin)
-- reviews. Soft-lifecycle only via `status` — we never delete
-- (see memory: keep-everything / soft-delete).
CREATE TABLE IF NOT EXISTS feature_requests (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submitted_by_user_id uuid NOT NULL REFERENCES users(id),
  submitter_role      text NOT NULL,
  title               text NOT NULL,
  description         text NOT NULL,
  status              text NOT NULL DEFAULT 'new'
                        CHECK (status IN ('new','reviewing','planned','declined','shipped')),
  admin_notes         text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_feature_requests_status ON feature_requests(status);
CREATE INDEX IF NOT EXISTS idx_feature_requests_submitter ON feature_requests(submitted_by_user_id);
