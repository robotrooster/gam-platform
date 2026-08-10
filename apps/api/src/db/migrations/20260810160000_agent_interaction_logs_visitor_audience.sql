-- S601: add the 'visitor' agent audience.
--
-- The 'visitor' audience is the pre-booking property agent (Skye) that lives on
-- a landlord's public booking subdomain. It answers pricing/availability and can
-- start a reservation, hard-scoped to the ONE property whose slug the visitor is
-- on. Interaction logging attributes those turns to that property + its landlord,
-- so the audience CHECK on agent_interaction_logs must accept 'visitor' or the
-- (best-effort) log insert would silently drop every visitor turn.
--
-- No backfill needed — additive value only; existing rows are unaffected.

ALTER TABLE agent_interaction_logs
  DROP CONSTRAINT IF EXISTS agent_interaction_logs_audience_check;

ALTER TABLE agent_interaction_logs
  ADD CONSTRAINT agent_interaction_logs_audience_check
  CHECK (audience = ANY (ARRAY['tenant'::text, 'landlord'::text, 'prospect'::text, 'guest'::text, 'visitor'::text]));
