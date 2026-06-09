-- Credit Ledger v1: events table.
--
-- Hash-chained, append-only event log. Each subject has its own chain
-- (prev_hash references the prior event for the same subject_id).
-- The first event for a subject has prev_hash = NULL.
--
-- this_hash = sha256(
--   prev_hash_or_zeros ||
--   canonical_json(event_data) ||
--   occurred_at_iso ||
--   attestation_source ||
--   canonical_json(attestation_evidence)
-- )
--
-- The hash is computed in the service layer (credit-ledger.ts) and
-- persisted here verbatim. verifyChain() walks subject events in
-- recorded_at order and recomputes hashes to detect tampering.
--
-- event_type is TEXT not enum: enum churn under fix-forward-only is
-- expensive, and the catalog of event types is large + growing.
-- The shared package CreditEventType enum is the source of truth;
-- application code validates before insert. Storing as TEXT lets us
-- add new types in shared+code without a migration.
--
-- attestation_source same reasoning.
--
-- network_visibility CHECK is enforced at DB level since it's a small,
-- stable set and visibility is a hard security boundary.
--
-- superseded_by + superseded_reason are how corrections work. We never
-- DELETE an event; we INSERT a new corrected event and set the original's
-- superseded_by pointer to the new event's id. Score recomputation walks
-- only non-superseded events.
--
-- dimension_tags is gin-indexed for fast filtering ("show me all
-- payment_reliability events for this subject"). Multi-valued because
-- some events tag multiple dimensions (a deposit_returned_full event
-- touches both property_care and cooperation).
--
-- No backfill needed: append-only by definition.

CREATE TABLE credit_events (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_id           UUID NOT NULL REFERENCES credit_subjects(id),
  event_type           TEXT NOT NULL,
  event_data           JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at          TIMESTAMPTZ NOT NULL,
  recorded_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  attestation_source   TEXT NOT NULL,
  attestation_evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  dimension_tags       TEXT[] NOT NULL DEFAULT '{}',
  network_visibility   TEXT NOT NULL CHECK (network_visibility IN (
    'private_to_subject',
    'visible_to_current_landlord',
    'visible_to_gam_network'
  )),
  prev_hash            BYTEA,
  this_hash            BYTEA NOT NULL,
  superseded_by        UUID REFERENCES credit_events(id),
  superseded_reason    TEXT
);

CREATE INDEX idx_credit_events_subject     ON credit_events (subject_id, occurred_at);
CREATE INDEX idx_credit_events_type        ON credit_events (event_type);
CREATE INDEX idx_credit_events_chain       ON credit_events (subject_id, recorded_at);
CREATE INDEX idx_credit_events_dimensions  ON credit_events USING gin (dimension_tags);
CREATE INDEX idx_credit_events_active      ON credit_events (subject_id) WHERE superseded_by IS NULL;
