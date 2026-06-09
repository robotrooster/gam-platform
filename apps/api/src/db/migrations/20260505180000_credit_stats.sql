-- Credit Ledger v1: derived stats panel.
--
-- Disclosable summary statistics derived from the event chain. Refreshed
-- nightly by the stats service (Session B). One row per subject; updated
-- in-place (PRIMARY KEY on subject_id, no insert history needed because
-- stats are derived — recomputable from events at any point).
--
-- Each *_stats jsonb holds the dimension's computed shape. Example shape
-- for payment_stats (see credit-ledger spec §Stats Panel):
--   {
--     "lifetime": { "total_events": ..., "on_time_pct": ..., ... },
--     "rolling_12mo": { ... },
--     "rolling_90d": { ... },
--     "trend_slope_12mo": ...,
--     "longest_on_time_streak_months": ...,
--     "current_on_time_streak_months": ...,
--     "lifetime_dollars_handled_reliably": ...
--   }
--
-- v1 generates the panel and exposes via internal-gated endpoint. v2+
-- enables tenant-controlled external disclosure of the stats panel
-- (without exposing the score itself).
--
-- ledger_event_count_at_computation tracks how many events the panel
-- was computed against, so consumers can detect staleness without
-- comparing JSON.
--
-- No backfill needed.

CREATE TABLE credit_stats (
  subject_id                          UUID PRIMARY KEY REFERENCES credit_subjects(id),
  payment_stats                       JSONB NOT NULL DEFAULT '{}'::jsonb,
  property_stats                      JSONB NOT NULL DEFAULT '{}'::jsonb,
  tenancy_stats                       JSONB NOT NULL DEFAULT '{}'::jsonb,
  community_stats                     JSONB NOT NULL DEFAULT '{}'::jsonb,
  cooperation_stats                   JSONB NOT NULL DEFAULT '{}'::jsonb,
  computed_at                         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ledger_event_count_at_computation   BIGINT NOT NULL
);
