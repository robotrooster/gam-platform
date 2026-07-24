-- S553: 'rate_limited' outcome — turns refused by the per-user daily
-- budget (abuse guard). The budget serves a canned reply with zero model
-- calls; logging the refusal keeps the analytics picture honest and lets
-- the heaviest-users table show who is hitting caps.
-- Single source: AGENT_OUTCOMES in services/agents/types.ts — keep in sync.
-- No backfill needed: the outcome is new behavior.

ALTER TABLE agent_interaction_logs
  DROP CONSTRAINT IF EXISTS agent_interaction_logs_outcome_check;

ALTER TABLE agent_interaction_logs
  ADD CONSTRAINT agent_interaction_logs_outcome_check CHECK (outcome = ANY (ARRAY[
    'answered_entry'::text,
    'answered_escalation'::text,
    'action_taken'::text,
    'escalated_to_senior'::text,
    'escalated_to_human'::text,
    'abandoned'::text,
    'error'::text,
    'shed'::text,
    'rate_limited'::text
  ]));
