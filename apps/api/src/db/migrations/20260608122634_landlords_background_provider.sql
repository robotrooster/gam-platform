-- S423: per-landlord background_provider selection.
--
-- Pre-S423 the background-check submission route hardcoded
-- provider_name='mock' at two places (background.ts:293 inside the
-- INSERT and background.ts:333 in getProvider('mock')). To enable
-- Checkr (or any future provider), the route needs runtime
-- selection — and the natural unit of selection is the landlord
-- (different landlords pay for different products).
--
-- Default 'mock' keeps existing landlords behaving unchanged. New
-- landlords default to 'mock' too; admin can flip a row to 'checkr'
-- once Checkr is provisioned for that landlord.
--
-- The CHECK constraint mirrors the providers registered in
-- services/backgroundProvider.ts. If a future provider is added,
-- both this CHECK and the PROVIDERS map need updating — same
-- "single source of truth for enums" rule as elsewhere.

ALTER TABLE landlords
  ADD COLUMN background_provider text DEFAULT 'mock' NOT NULL,
  ADD CONSTRAINT landlords_background_provider_check
    CHECK (background_provider IN ('mock', 'checkr'));

COMMENT ON COLUMN landlords.background_provider IS
  'S423: which background-check provider this landlord uses. Default mock; flip to checkr once Checkr is provisioned for the landlord.';
