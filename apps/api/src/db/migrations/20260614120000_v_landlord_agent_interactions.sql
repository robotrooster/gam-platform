-- S480: landlord-facing agent_interaction_logs VIEW.
--
-- The full agent_interaction_logs table carries verbatim user_message
-- and agent_reply text (admin-only per the agent-engine design pass),
-- plus tool_invocations / human_handoff / error_detail JSON that may
-- contain user-supplied text. The landlord-facing surface only needs
-- METADATA — counts, outcomes, tool names, agent identity, latency,
-- timestamps — for reporting and oversight without exposing the
-- conversation content.
--
-- This VIEW is the SINGLE definition of which columns are landlord-
-- safe. Routes scoped to landlord_id should SELECT FROM the view, not
-- the base table. Admin / super_admin routes that need the full content
-- continue to SELECT FROM agent_interaction_logs.
--
-- Explicitly OMITTED columns + why:
--   user_message       — tenant or landlord verbatim turn; admin-only.
--   agent_reply        — agent verbatim turn; admin-only.
--   tool_invocations   — args JSON often contains free-form user data
--                        (e.g. driver_notes on skip, message bodies on
--                        send_bulk_message). Exposes too much.
--   human_handoff      — escalation package; includes transcript snippet.
--   error_detail       — stack trace; ops-only signal.
--   knowledge_chunk_ids — RAG plumbing; not useful to landlord.
--   metadata           — free-form jsonb; future-flexible, not landlord-facing.
--   profile_id         — agent-engine internal profile slug; not a UI signal.
--   actor_subject_id   — duplicate of actor_user_id for non-prospect audiences;
--                        omitted for clarity.
--
-- The actor_user_id column IS included — landlord sees their own
-- tenants on the dashboard and may need to filter by user. Route-layer
-- scoping (landlord_id = actor.profileId) plus the tenant-in-own-property
-- relationship means this exposure is acceptable. If a stricter view is
-- needed later (e.g., when PM-company staff get dashboard access without
-- tenant-identification rights), a second VIEW can split actor_user_id
-- out.
--
-- SAFE — additive only: a VIEW, no schema change to the underlying
-- table, no data migration needed.

CREATE OR REPLACE VIEW public.v_landlord_agent_interactions AS
SELECT
    id,
    conversation_id,
    turn_index,
    agent_type,
    audience,
    agent_name,
    handled_by_tier,
    outcome,
    property_id,
    landlord_id,
    actor_user_id,
    actor_role,
    escalation_count,
    escalated_to_human,
    tool_invocation_count,
    tool_names,
    latency_ms,
    prompt_tokens,
    completion_tokens,
    model,
    grounded,
    created_at
FROM public.agent_interaction_logs;

COMMENT ON VIEW public.v_landlord_agent_interactions IS
    'S480 landlord-facing agent_interaction_logs metadata-only view. Omits verbatim user_message / agent_reply / tool_invocations / human_handoff / error_detail / knowledge_chunk_ids / metadata / profile_id / actor_subject_id. Route-layer scoping must add landlord_id = actor.profileId.';
