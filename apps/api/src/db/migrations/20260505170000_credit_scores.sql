-- Credit Ledger v1: score snapshots.
--
-- Periodic snapshots of computed scores. Computed nightly by the score
-- service (Session B), and on-demand on dispute resolution. Each snapshot
-- references the formula version it was computed under, so re-running
-- last year's score against this year's formula produces a comparable
-- pair, not a single overwriting number.
--
-- composite_score is unbounded. NUMERIC(20,2) gives ample headroom; a
-- tenant accumulating 1M+ points sits comfortably under that bound.
--
-- confidence_low / confidence_high persist for backward-compat with the
-- credit-ledger spec but are populated as composite_score itself in
-- v1.0.0 because the locked design dropped the ± interval in favor of
-- event_count as the uncertainty signal. Future formula versions can
-- repopulate them if a different uncertainty model lands.
--
-- dimension_scores is a JSONB shape:
--   { "payment_reliability": <num>, "property_care": <num>, ... }
-- v1.0.0 populates these as informational rollups (sum of events tagged
-- to that dimension), not separate scoring axes.
--
-- ledger_merkle_root captures the Merkle root over all events as of
-- computation time, so a score snapshot can be cryptographically
-- linked to the chain state it was derived from.
--
-- disclosure_scope = 'gam_internal_only' for all v1 records. Middleware
-- gates the score endpoint to internal lending services only. v2+
-- introduces additional disclosure scopes (consumer-controlled sharing).
--
-- No backfill needed: snapshots start from first nightly cron run.

CREATE TABLE credit_scores (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_id         UUID NOT NULL REFERENCES credit_subjects(id),
  composite_score    NUMERIC(20,2) NOT NULL,
  confidence_low     NUMERIC(20,2) NOT NULL,
  confidence_high    NUMERIC(20,2) NOT NULL,
  dimension_scores   JSONB NOT NULL DEFAULT '{}'::jsonb,
  event_count        INTEGER NOT NULL,
  formula_version    TEXT NOT NULL REFERENCES credit_score_formulas(version),
  disclosure_scope   TEXT NOT NULL DEFAULT 'gam_internal_only' CHECK (disclosure_scope IN (
    'gam_internal_only'
  )),
  ledger_merkle_root BYTEA NOT NULL,
  computed_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_credit_scores_subject ON credit_scores (subject_id, computed_at DESC);
