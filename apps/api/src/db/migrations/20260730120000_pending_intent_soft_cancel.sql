-- Soft-cancel for pending tenant invites (data-retention rule, S568).
--
-- WHY: Nic's standing rule is "keep everything — a delete only hides a record
-- from the owner's view, it never leaves our server." The pending-invite cancel
-- (DELETE /api/landlords/me/pending-tenants/:intentId) was the ONE runtime path
-- that actually erased data: it hard-deleted the tenant row, the user row, and
-- unlinked the uploaded PDF. Even though it was guarded to no-lease-history
-- invites, an aborted invite still carries a real person's contact info (name,
-- email, phone) plus any uploaded lease PDF — all of which we now retain.
--
-- This column turns that cancel into a soft-hide: the intent (and the tenant /
-- user / PDF behind it) stay on the server; cancelled_at just drops the invite
-- out of the landlord's pending list and frees the held unit / person for a new
-- invite. resolved_at stays reserved for "became a real lease"; cancelled_at is
-- the distinct "landlord backed out" terminal state.
--
-- No backfill needed: existing rows are either open (NULL, correct) or already
-- resolved. Nothing was previously cancelled-in-place (the old path deleted).

ALTER TABLE pending_tenant_intents
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;

COMMENT ON COLUMN pending_tenant_intents.cancelled_at IS
  'Set when a landlord backs out of a pending invite. Soft-hide: the row + its tenant/user/PDF are retained on the server; the invite just leaves the landlord''s view and releases the held unit. Distinct from resolved_at (became a lease).';
