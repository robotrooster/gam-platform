-- S571 — Maintenance redesign: the tenant no longer picks a priority.
-- The in-house tenant agent (Ava) RECOMMENDS a priority at submit time from the
-- category + description; the landlord can override the effective `priority`.
-- We keep BOTH values so the landlord can see what the agent suggested vs. what
-- they set, and so the recommendation is auditable/transparent to the tenant.
--
-- `recommended_priority` is nullable: pre-S571 rows have none, and landlord-filed
-- requests may skip the recommendation. Same CHECK values as `priority`.
-- No backfill needed (historical rows keep their existing `priority`).
ALTER TABLE maintenance_requests
  ADD COLUMN IF NOT EXISTS recommended_priority text
    CHECK (recommended_priority IN ('emergency','high','normal','low'));

-- How the recommendation was produced, for transparency + eval: 'agent' (live
-- in-house LLM), 'heuristic' (deterministic fallback when the model was
-- unreachable), or NULL (landlord-filed / pre-S571).
ALTER TABLE maintenance_requests
  ADD COLUMN IF NOT EXISTS priority_source text
    CHECK (priority_source IN ('agent','heuristic','landlord'));
