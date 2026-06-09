-- Credit Ledger v1: disputes table.
--
-- A dispute is a first-class lifecycle object. Opening a dispute
-- generates a 'dispute_opened' event in credit_events; resolving it
-- generates a 'dispute_resolved_*' event. The dispute row itself
-- tracks status (open / evidence_pending / resolved_*), the original
-- disputed event, the disputing subject, and pointers back to the
-- ledger events bracketing the lifecycle.
--
-- We don't FK status to a separate enum table — the small set lives in
-- shared/CreditEventType plus DisputeStatus enums. CHECK enforces the
-- DB-level invariant.
--
-- resolution_event_id is nullable until the dispute resolves. When it
-- resolves with 'resolved_corrected', the disputed event also gets its
-- superseded_by pointer set to the corrected event (handled in service
-- layer, not via trigger — explicit code path is easier to audit).
--
-- No backfill needed: dispute lifecycle starts post-launch.

CREATE TABLE credit_disputes (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  disputed_event_id        UUID NOT NULL REFERENCES credit_events(id),
  disputing_subject_id     UUID NOT NULL REFERENCES credit_subjects(id),
  dispute_open_event_id    UUID NOT NULL REFERENCES credit_events(id),
  status                   TEXT NOT NULL CHECK (status IN (
    'open',
    'evidence_pending',
    'resolved_upheld',
    'resolved_corrected',
    'resolved_no_change'
  )),
  resolution_event_id      UUID REFERENCES credit_events(id),
  reason                   TEXT NOT NULL CHECK (reason IN (
    'factual_inaccuracy',
    'attestation_invalid',
    'identity_mismatch',
    'other'
  )),
  notes                    TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at              TIMESTAMPTZ
);

CREATE INDEX idx_credit_disputes_subject ON credit_disputes (disputing_subject_id);
CREATE INDEX idx_credit_disputes_event   ON credit_disputes (disputed_event_id);
CREATE INDEX idx_credit_disputes_status  ON credit_disputes (status);
