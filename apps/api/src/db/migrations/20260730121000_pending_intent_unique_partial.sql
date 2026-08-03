-- Make the one-intent-per-tenant uniqueness ignore cancelled invites (S568).
--
-- WHY: pending_tenant_intents had a full UNIQUE (tenant_id) — at most one intent
-- row per person, ever. That worked when canceling an invite HARD-DELETED the
-- row (the slot freed up). Now that cancel is a soft-hide (cancelled_at stamped,
-- row retained — see 20260730120000), a cancelled invite would permanently
-- occupy the tenant's unique slot and block re-inviting the same person. That
-- contradicts the retention design: we keep the cancelled invite as history AND
-- allow a fresh invite.
--
-- Fix: drop the total unique constraint and replace it with a PARTIAL unique
-- index scoped to non-cancelled rows. Semantics preserved: a tenant may have at
-- most one LIVE (open or resolved) intent at a time; any number of cancelled
-- ones may accumulate as retained history.
--
-- No data change; cancelled rows didn't exist before this session, so no
-- backfill and no risk of an existing duplicate violating the new partial index.

ALTER TABLE pending_tenant_intents
  DROP CONSTRAINT IF EXISTS pending_tenant_intents_tenant_id_key;

CREATE UNIQUE INDEX IF NOT EXISTS pending_tenant_intents_tenant_id_live_key
  ON pending_tenant_intents (tenant_id)
  WHERE cancelled_at IS NULL;
