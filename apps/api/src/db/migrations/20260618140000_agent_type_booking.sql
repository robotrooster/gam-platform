-- Admit 'booking' to the agent-logging agent_type CHECK.
--
-- The booking-guest agent (audience 'guest', persona "Skye") is its own
-- agentType 'booking' — like the sales agent, it carries its own prompt and
-- NOT the customer-service guardrails, so it must not be grouped with the CS
-- agents. Its interactions log to agent_interaction_logs with
-- agent_type='booking', which the prior CHECK (customer_service|sales) rejects.
--
-- No backfill needed — no existing rows use 'booking'.
ALTER TABLE agent_interaction_logs DROP CONSTRAINT IF EXISTS agent_interaction_logs_agent_type_check;
ALTER TABLE agent_interaction_logs ADD CONSTRAINT agent_interaction_logs_agent_type_check
  CHECK (agent_type = ANY (ARRAY['customer_service'::text, 'sales'::text, 'booking'::text]));
