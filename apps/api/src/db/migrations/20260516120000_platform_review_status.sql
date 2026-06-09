-- S296: platform_review_status — verification lifecycle for CSV imports.
--
-- Per-(platform_key, import_type) gate that controls whether new
-- uploads from a given platform/type combo escalate to super admin
-- review. Replaces the S295 "first 5 commits" heuristic with an
-- explicit verification flag set by super admin.
--
-- Lifecycle:
--   1. Default state: no row exists → treated as 'unverified' by the
--      service helper (getPlatformReviewStatus in services/
--      csvImportAttempts.ts). Every upload from this (platform, type)
--      escalates: the success banner appears on the landlord side
--      and the queue row sits in the super_admin review surface.
--   2. Super admin reviews enough imports (typically by upload #5
--      per Nic's SLA) and clicks "Mark verified" in the admin UI.
--      Inserts a row with mapping_status='verified', stamping
--      verified_by + verified_at.
--   3. Subsequent uploads from this slot bypass the banner + don't
--      surface in the pending-review queue. The platform is
--      battle-tested.
--   4. If we ever ship a mapping change that materially alters
--      column handling for the platform, super admin can revert
--      verified → unverified to force re-review of the next 5.
--
-- Per-import-type granularity (not just per-platform): the three
-- CSV pipelines (tenant / property / payment) use different
-- mapping arrays for each platform. DoorLoop tenant mapping
-- might be solid while DoorLoop payment mapping has gaps — they
-- verify independently.

CREATE TABLE platform_review_status (
  platform_key   text NOT NULL,
  import_type    text NOT NULL,
  mapping_status text NOT NULL DEFAULT 'unverified',
  verified_at    timestamptz,
  verified_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  notes          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (platform_key, import_type),
  CONSTRAINT platform_review_status_import_type_check
    CHECK (import_type = ANY (ARRAY['tenant'::text, 'property'::text, 'payment'::text])),
  CONSTRAINT platform_review_status_mapping_status_check
    CHECK (mapping_status = ANY (ARRAY['unverified'::text, 'verified'::text]))
);
