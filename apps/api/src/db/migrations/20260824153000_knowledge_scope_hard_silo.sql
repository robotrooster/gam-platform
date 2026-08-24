-- Agent knowledge: ONE scope per audience, no shared pool.
--
-- S620 (Nic): "the tenant agent keeps telling people stuff about the landlord
-- or the booking side that has nothing to do with being a tenant... maybe we
-- make them separate things and knowledge bases completely."
--
-- WHAT WAS WRONG. Scope filtering existed and worked, but every profile read
-- 'shared' on top of its own slice, and 'shared' was six articles written in
-- TENANT voice: resetting your password, two-factor, notification preferences,
-- "your rent amount, due date and late fees are set by your landlord".
--
--   • the GUEST agent (Skye, a booking guest with no account) and the SITE
--     VISITOR agent (pre-booking, no account) read NOTHING BUT those six.
--     100% of their retrievable knowledge was account mechanics for an account
--     they do not have, in the voice of a renter they are not.
--   • the SALES agent (Lucy, talking to a prospective LANDLORD) retrieved
--     "GAM is the platform, not your landlord — repairs are your landlord's
--     decision" and read it to someone who IS the landlord.
--   • and the cost of one pool is on record in the other direction: a landlord
--     was told a nightly booking cost 5% when it had been 3% since S616. One
--     stale article, every audience.
--
-- AFTER: scope IN (tenant, landlord, sales, guest, visitor) and each profile
-- carries exactly one. Retrieval already filters `WHERE scope = ANY($2)`
-- (services/agents/knowledge.ts), so a single-element list is a hard wall —
-- not a ranking preference that a well-worded question can defeat.
--
-- Universal facts are DUPLICATED per audience rather than shared, each copy in
-- that audience's voice, grouped by a `canonical:` frontmatter key.
-- knowledgeSilo.test.ts asserts every copy of a canonical key agrees on every
-- figure it states and that no scope is missing a copy — duplication without a
-- drift check is exactly how the 5% article survived.
--
-- Single source for this list: KNOWLEDGE_SCOPES in services/agents/types.ts.
--
-- DATA: the 'shared' rows are DELETED, not remapped. Their replacements are
-- new files under new paths, so re-ingest inserts fresh rows and cannot match
-- these by `source`. Chunks are a derived cache of the markdown in
-- services/agents/knowledge-content — deleting them loses nothing that is not
-- rebuilt by `ts-node src/services/agents/ingestKnowledge.ts`, which MUST be
-- run after this migration or those six articles are simply gone.

ALTER TABLE agent_knowledge_chunks
  DROP CONSTRAINT IF EXISTS agent_knowledge_chunks_scope_check;

DELETE FROM agent_knowledge_chunks WHERE scope = 'shared';

ALTER TABLE agent_knowledge_chunks
  ADD CONSTRAINT agent_knowledge_chunks_scope_check
  CHECK (scope IN ('tenant', 'landlord', 'sales', 'guest', 'visitor'));
