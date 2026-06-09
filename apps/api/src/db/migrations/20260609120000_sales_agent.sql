-- Sales lead-gen agent (a NEW agent type — validates the agentType axis).
--
-- WHY: GAM wants a public, unauthenticated agent on the marketing site that
-- engages prospects, answers product questions, qualifies them, and captures
-- a lead for the human sales team. This is the first non-customer-service
-- agent. Three schema changes support it:
--   1. agent_knowledge_chunks.scope gains 'sales' (persuasive marketing copy,
--      kept separate from the support KB).
--   2. agent_interaction_logs gains agent_type 'sales' + audience 'prospect'
--      (the same engine logs sales turns; prospects have no GAM user, so
--      actor_user_id is NULL for them).
--   3. a new sales_leads table holds captured leads.
--
-- ENUM SINGLE-SOURCE: the extended CHECKs mirror AGENT_TYPES /
-- AGENT_AUDIENCES / KNOWLEDGE_SCOPES in services/agents/types.ts — keep in
-- sync. CHECKs can't be altered in place, so each is dropped + re-added.
--
-- NO BACKFILL NEEDED: existing rows already satisfy the widened CHECKs;
-- sales_leads starts empty.

-- 1. knowledge scope: add 'sales'
ALTER TABLE agent_knowledge_chunks DROP CONSTRAINT agent_knowledge_chunks_scope_check;
ALTER TABLE agent_knowledge_chunks ADD CONSTRAINT agent_knowledge_chunks_scope_check
  CHECK (scope IN ('tenant', 'landlord', 'shared', 'sales'));

-- 2. interaction-log enums: add 'sales' agent_type + 'prospect' audience
ALTER TABLE agent_interaction_logs DROP CONSTRAINT agent_interaction_logs_agent_type_check;
ALTER TABLE agent_interaction_logs ADD CONSTRAINT agent_interaction_logs_agent_type_check
  CHECK (agent_type IN ('customer_service', 'sales'));
ALTER TABLE agent_interaction_logs DROP CONSTRAINT agent_interaction_logs_audience_check;
ALTER TABLE agent_interaction_logs ADD CONSTRAINT agent_interaction_logs_audience_check
  CHECK (audience IN ('tenant', 'landlord', 'prospect'));

-- 3. captured leads. Free-form fields (the agent captures what comes up
-- naturally + gently asks portfolio size/type). status drives the sales
-- team's follow-up pipeline.
CREATE TABLE sales_leads (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid,                       -- the sales chat it came from
  name            text,
  email           text,
  phone           text,
  portfolio_size  text,                        -- free-form, e.g. "about 40 units"
  property_type   text,                        -- free-form, e.g. "RV park + apartments"
  notes           text,                        -- interest / qualification gist
  status          text NOT NULL DEFAULT 'new'
                  CHECK (status IN ('new', 'contacted', 'qualified', 'converted', 'closed')),
  source          text NOT NULL DEFAULT 'sales_agent',
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- New-lead queue for the sales team (newest first).
CREATE INDEX sales_leads_status_idx ON sales_leads (status, created_at DESC);
