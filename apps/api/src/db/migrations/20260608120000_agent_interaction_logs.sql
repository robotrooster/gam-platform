-- Agent interaction logs (customer-service AI agents, Step 6).
--
-- WHY: every completed agent interaction (one runAgentSession turn) is
-- logged here so we can (a) review quality / hallucinations / tone for
-- QA, (b) debug and replay escalation handoffs, and (c) later power a
-- landlord-facing per-agent performance report by simply GROUP BY-ing
-- agent + property + outcome + time. This is the "per-interaction
-- logging tagged with agent + property + outcome" the build handoff
-- calls for. Sibling of agent_knowledge_chunks in the same subsystem —
-- matches its style (gen_random_uuid PK, jsonb metadata default '{}').
--
-- ENUM SINGLE-SOURCE: the CHECKed text columns mirror the readonly value
-- arrays in services/agents/types.ts — keep them in sync (CLAUDE.md enum
-- rule), exactly as agent_knowledge_store mirrors KNOWLEDGE_SCOPES:
--   agent_type      ↔ AGENT_TYPES
--   audience        ↔ AGENT_AUDIENCES
--   handled_by_tier ↔ AGENT_TIERS + the terminal literal 'human'
--   outcome         ↔ AGENT_OUTCOMES
-- PROMOTION TRIGGER: when a logging route or landlord dashboard imports
-- these values, promote the arrays to packages/shared so migration +
-- route + UI share one source.
--
-- PRIVACY: user_message / agent_reply / tool_invocations / human_handoff
-- hold verbatim tenant content and must stay admin/super_admin-only. The
-- future landlord performance report must read ONLY the aggregate/metric
-- columns via a metadata-only view, filtered to the caller's landlord_id
-- server-side. property_id/landlord_id are SNAPSHOTTED at log time so a
-- later lease change never re-attributes old interactions (ledger
-- snapshot-routing principle).
--
-- NO BACKFILL NEEDED: new table, starts empty. Written best-effort by
-- services/agents/logInteraction.ts (a log failure never breaks a reply).
-- Reserved/unemitted-in-v1 outcomes: 'escalated_to_senior', 'abandoned'.
-- Retention (follow-up, not this migration): add to the S133 monthly
-- _archive policy + a content-scrub job that NULLs the verbatim columns
-- after a conversation closes + a QA window passes.

CREATE TABLE agent_interaction_logs (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- conversation grouping
  conversation_id       uuid NOT NULL,
  turn_index            integer NOT NULL DEFAULT 0,

  -- which agent (generic axes + the concrete handler)
  agent_type            text NOT NULL CHECK (agent_type IN ('customer_service')),
  audience              text NOT NULL CHECK (audience IN ('tenant', 'landlord')),
  profile_id            text NOT NULL,
  agent_name            text NOT NULL,
  handled_by_tier       text NOT NULL CHECK (handled_by_tier IN ('entry', 'escalation', 'human')),

  -- the headline reporting dimension
  outcome               text NOT NULL CHECK (outcome IN (
                          'answered_entry', 'answered_escalation', 'action_taken',
                          'escalated_to_senior', 'escalated_to_human', 'abandoned', 'error')),

  -- attribution (snapshotted at log time; nullable for landlord/portfolio
  -- turns and applicants with no active lease)
  property_id           uuid REFERENCES properties(id) ON DELETE SET NULL,
  landlord_id           uuid REFERENCES landlords(id) ON DELETE SET NULL,

  -- the customer (FK SET NULL so audit rows survive user deletion)
  actor_user_id         uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_role            text NOT NULL,
  actor_subject_id      text NOT NULL,

  -- escalation shape
  escalation_count      smallint NOT NULL DEFAULT 0,
  escalated_to_human    boolean NOT NULL DEFAULT false,
  escalations           jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- tool usage
  tool_invocation_count smallint NOT NULL DEFAULT 0,
  tool_names            text[] NOT NULL DEFAULT '{}'::text[],
  tool_invocations      jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- engine / RAG health metrics
  latency_ms            integer,
  prompt_tokens         integer,
  completion_tokens     integer,
  model                 text,
  grounded              boolean,
  knowledge_chunk_ids   uuid[] NOT NULL DEFAULT '{}'::uuid[],

  -- verbatim content (ADMIN-ONLY — never exposed to landlords)
  user_message          text NOT NULL,
  agent_reply           text NOT NULL,
  human_handoff         jsonb,
  error_detail          text,

  metadata              jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at            timestamptz NOT NULL DEFAULT now()
);

-- Canonical per-landlord / per-property / per-agent report (near
-- index-only GROUP BY for the future performance dashboard).
CREATE INDEX agent_interaction_logs_landlord_report_idx
  ON agent_interaction_logs (landlord_id, property_id, agent_type, outcome, created_at DESC);

-- Global dashboard feed + archive-sweep cutoff scan.
CREATE INDEX agent_interaction_logs_created_at_idx
  ON agent_interaction_logs (created_at DESC);

-- Reconstruct a full thread in order for QA.
CREATE INDEX agent_interaction_logs_conversation_idx
  ON agent_interaction_logs (conversation_id, turn_index);

-- Per-user volume / repeat-contact / abuse lookups.
CREATE INDEX agent_interaction_logs_actor_idx
  ON agent_interaction_logs (actor_user_id);

-- Human-handoff review queue (partial index, like csv_import_attempts).
CREATE INDEX agent_interaction_logs_human_queue_idx
  ON agent_interaction_logs (created_at DESC) WHERE escalated_to_human;

-- Error-rate / failure-triage feed.
CREATE INDEX agent_interaction_logs_error_idx
  ON agent_interaction_logs (created_at DESC) WHERE outcome = 'error';
