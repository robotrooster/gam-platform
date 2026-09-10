-- S639 (Nic): "We need a way to save all that data that is coming through.
-- Start collecting it for future use."
--
-- Today only a normalised summary survives — a status per product plus the
-- handful of figures that explain it. Everything else Checkr sends is read once
-- and dropped. That is fine for deciding a tenancy and useless for everything
-- after: a disputed result, a re-screen a year on, a question about what the
-- provider actually said on the day.
--
-- So the payload is kept verbatim, append-only, one row per fetch or webhook.
-- Append-only matters: a report can change (a dispute resolves, a record is
-- expunged), and the answer to "what did we decide on" has to be what the
-- provider said AT THAT TIME, not what it says now.
--
-- HANDLING. This is consumer report data under the FCRA. Two consequences the
-- schema can carry:
--   · it is never tenant-facing and never leaves the landlord/admin surfaces —
--     the applicant's own copy comes from the CRA, not from us;
--   · FCRA §628 requires reasonable DISPOSAL, so rows carry a purge_after date
--     rather than living forever by default. Nothing purges them yet; the column
--     exists so a retention job has something to honour when Nic sets a period.
CREATE TABLE IF NOT EXISTS background_check_reports (
  id                   uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  background_check_id  uuid NOT NULL REFERENCES background_checks(id) ON DELETE CASCADE,
  landlord_id          uuid REFERENCES landlords(id),
  provider             text NOT NULL,
  report_ref           text,
  -- 'fetch' (we asked) or 'webhook' (they told us) — the two ways a payload
  -- arrives, worth telling apart when reconstructing a timeline.
  source               text NOT NULL CHECK (source IN ('fetch', 'webhook')),
  event_type           text,
  payload              jsonb NOT NULL,
  received_at          timestamptz NOT NULL DEFAULT now(),
  purge_after          date
);

CREATE INDEX IF NOT EXISTS idx_bg_reports_check
  ON background_check_reports (background_check_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_bg_reports_landlord
  ON background_check_reports (landlord_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_bg_reports_purge
  ON background_check_reports (purge_after) WHERE purge_after IS NOT NULL;

COMMENT ON TABLE background_check_reports IS
  'S639: append-only archive of every raw provider payload for a background check. Consumer report data — landlord/admin surfaces only, never tenant-facing. purge_after supports FCRA-reasonable disposal once a retention period is chosen.';
