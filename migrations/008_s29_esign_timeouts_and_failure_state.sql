-- Migration 008: S29 e-sign timeouts and failure-state tracking
-- - Adds 'execution_failed' to lease_documents.status CHECK
-- - Adds execution_failed_at timestamp (permanent admin signal, survives voiding)
-- - Adds invite_sent_at + reminder_sent_at on lease_document_signers
-- - Backfills invite_sent_at from created_at for already-sent signers

BEGIN;

ALTER TABLE lease_documents
  DROP CONSTRAINT lease_documents_status_check;

ALTER TABLE lease_documents
  ADD CONSTRAINT lease_documents_status_check
  CHECK (status IN ('pending','sent','in_progress','completed','voided','execution_failed'));

ALTER TABLE lease_documents
  ADD COLUMN execution_failed_at TIMESTAMPTZ;

ALTER TABLE lease_document_signers
  ADD COLUMN invite_sent_at TIMESTAMPTZ;

ALTER TABLE lease_document_signers
  ADD COLUMN reminder_sent_at TIMESTAMPTZ;

UPDATE lease_document_signers
SET invite_sent_at = created_at
WHERE invite_sent = TRUE AND invite_sent_at IS NULL;

COMMIT;
