-- S581 (Leases + e-sign sweep): idempotent document finalization.
--
-- WHY: buildLeaseFromDocument() is triggered when the sign route detects "all
-- signers done" — but that detection runs POST-commit with a check-then-act
-- COUNT, and the lease INSERT has no DB backstop (no unique document->lease
-- link, no one-active-lease-per-unit constraint). So a duplicate or racing
-- FINAL signature — a double-click, or two tied-order co-tenants both submitting
-- last — could finalize the SAME document twice:
--   * original_lease  -> a SECOND lease + move-in invoice (double deposit +
--                        double first-month rent + double PM leasing fee)
--   * addendum_add/remove/terms -> a re-added / re-removed tenant or a
--                        re-applied term change
--   * sublease_agreement -> a re-activated sublease
--
-- FIX: the builder takes a per-document advisory xact lock and stamps
-- finalized_at at the END of a successful build (inside that same txn, so it
-- commits before the lock releases). A second finalization that then acquires
-- the lock sees finalized_at set and returns the already-built result instead of
-- applying the document a second time. Covers every document_type uniformly.
--
-- Backfill: mark existing COMPLETED docs finalized (completed_at) so a
-- hypothetical re-entry on historical rows also no-ops. execution_failed docs
-- stay NULL on purpose — a fix-forward retry must still be able to build.
-- Safe add (nullable, no other backfill needed).

ALTER TABLE lease_documents ADD COLUMN IF NOT EXISTS finalized_at timestamptz;

UPDATE lease_documents
   SET finalized_at = completed_at
 WHERE status = 'completed'
   AND completed_at IS NOT NULL
   AND finalized_at IS NULL;
