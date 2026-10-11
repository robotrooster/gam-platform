-- 10/4 (Nic): "I want all of the AI agents disabled until we get them worked
-- out ... we're going to have to train them again."
--
-- ONE platform switch for every AI assistant (tenant, landlord, sales, guest
-- stay page, booking sites). routes/agent.ts reads it; a missing row already
-- reads as OFF, so this row exists only so the owner can see and flip it in the
-- admin feature switches. Inserted OFF. Data-only; no backfill needed.
INSERT INTO system_features (key, enabled, description)
VALUES ('ai_assistants_enabled', FALSE,
        'All AI assistants (tenant, landlord, sales, guest stay page, booking sites). Off until they are retrained.')
ON CONFLICT (key) DO NOTHING;
