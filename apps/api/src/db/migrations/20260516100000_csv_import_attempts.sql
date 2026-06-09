-- S295: csv_import_attempts — review queue for CSV migrations.
--
-- Every validate + commit through the three CSV-import handlers
-- (apps/api/src/routes/landlords.ts: onboard-properties-csv,
-- onboard-tenants-csv, onboard-payment-history-csv) appends a row
-- here. Captures the source-platform shape (column headers + first
-- 5 sample rows raw) so super admins can verify mapping accuracy
-- against real customer uploads.
--
-- Product motivation (Nic, S295): the first 5 customers to migrate
-- from any specific platform are likely to expose mapping gaps we
-- haven't seen. By capturing each attempt with raw column shape we
-- can review and refine mappings before more customers hit the
-- same gaps. After 5 successful commits from one (platform,
-- import_type) the platform is considered "battle-tested" — the
-- S296 verification lifecycle adds the explicit verified flag.
--
-- Column notes:
--   - import_type       — which of the 3 CSV pipelines wrote this
--   - platform_key      — the CsvImportPlatform enum value
--                         ('buildium', 'doorloop', 'generic', etc.)
--   - claimed_platform_name — set only on generic uploads in S297
--                             (free-text "what platform is this?").
--                             NULL for non-generic. Indexed for the
--                             promotion-aggregation query.
--   - column_headers    — original-case headers seen in the upload,
--                         in source order. JSONB array of strings.
--                         For mapping-accuracy review.
--   - sample_rows       — first 5 rows of the raw CSV (post-parse,
--                         pre-applyMapping). JSONB array of
--                         objects, original-case keys preserved.
--                         Tenant PII included; access gated to
--                         super_admin only.
--   - row_count         — total rows in the upload (committed or
--                         not). For validate attempts: rows parsed.
--                         For commit attempts: rows persisted.
--   - blockers / warnings — counts from validate summary; 0 on
--                          commit rows (commit only runs if no
--                          blockers remain).
--   - status            — 'validated' (validate run, may or may
--                         not commit) | 'committed' (commit
--                         succeeded) | 'reviewed' (super admin
--                         marked the row reviewed in the queue).
--   - reviewed_by / reviewed_at — set when super admin clicks
--                                 "mark reviewed" in S295's admin
--                                 surface.
--
-- No backfill — historical imports (pre-S295) weren't captured.
-- New imports start populating from migration-apply forward.

CREATE TABLE csv_import_attempts (
  id                     uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  landlord_id            uuid NOT NULL REFERENCES landlords(id) ON DELETE CASCADE,
  import_type            text NOT NULL,
  platform_key           text NOT NULL,
  claimed_platform_name  text,
  column_headers         jsonb NOT NULL DEFAULT '[]'::jsonb,
  sample_rows            jsonb NOT NULL DEFAULT '[]'::jsonb,
  row_count              integer NOT NULL DEFAULT 0,
  blockers               integer NOT NULL DEFAULT 0,
  warnings               integer NOT NULL DEFAULT 0,
  status                 text NOT NULL DEFAULT 'validated',
  reviewed_by            uuid REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at            timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT csv_import_attempts_import_type_check
    CHECK (import_type = ANY (ARRAY['tenant'::text, 'property'::text, 'payment'::text])),
  CONSTRAINT csv_import_attempts_status_check
    CHECK (status = ANY (ARRAY['validated'::text, 'committed'::text, 'reviewed'::text]))
);

-- Counter index: "how many prior commits for this (platform, import_type)?"
-- powers the firstFive position check on commit-success.
CREATE INDEX idx_csv_import_attempts_platform_committed
  ON csv_import_attempts (platform_key, import_type)
  WHERE status = 'committed';

-- Admin review-queue index: pending-review list sorted newest-first.
CREATE INDEX idx_csv_import_attempts_pending
  ON csv_import_attempts (created_at DESC)
  WHERE status IN ('validated', 'committed');

-- Per-landlord lookup (admin queue may filter by landlord).
CREATE INDEX idx_csv_import_attempts_landlord
  ON csv_import_attempts (landlord_id);

-- S297-ready: claimed-platform-name aggregation for promotion candidates.
-- NULL claim values won't appear in the index (partial); generic uploads
-- with a real claim do.
CREATE INDEX idx_csv_import_attempts_claimed_platform
  ON csv_import_attempts (lower(claimed_platform_name))
  WHERE claimed_platform_name IS NOT NULL;
