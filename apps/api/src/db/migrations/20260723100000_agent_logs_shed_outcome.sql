-- S553: log capacity-shed agent turns.
--
-- Why: the turn gate (agentSession) sheds turns under overload, but shed
-- turns were never written to agent_interaction_logs — so the one signal
-- that says "the model fleet is too small for demand" was invisible. The
-- admin Agent Analytics page alarms on shed volume; this adds 'shed' to the
-- outcome CHECK (single source: AGENT_OUTCOMES in services/agents/types.ts —
-- keep in sync).
--
-- No backfill needed: shed turns were previously not logged at all, so no
-- existing rows change meaning.

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
    'shed'::text
  ]));
